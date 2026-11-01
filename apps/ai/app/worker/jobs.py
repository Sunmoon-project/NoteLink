"""ai_jobs 작업 저장소: 가져오기 · 진행률 · 완료 · 실패.

NestJS가 작업을 넣고(status='queued'), 처리기가 꺼내 처리한 뒤 결과를 같은 문서에 씁니다.
FastAPI는 ai_jobs만 읽고 씁니다. 상태 · 필드 이름은 공용 스키마의 AiJob(packages/shared,
PR #31에서 추가 · 병합 전)을 따릅니다.

  queued ──가져오기──▶ running ──▶ succeeded
    ▲                   │   ├────▶ failed     입력 오류 · 코드 오류 · 시도 한도
    └───── 일시 오류 ────┘   └────▶ canceled   NestJS가 바꿈. 처리기는 결과를 버림

주고받는 필드
  NestJS가 넣음  type · targetType · targetId · userId · createdAt · input
                 status='queued' · progress=0 · attempts=0 · result=None · error=None
  처리기가 씀    status · progress · step · attempts · result · error
                 lockedBy · lockedUntil · retryAt · updatedAt
  - input: 처리기는 다른 컬렉션을 읽지 않으므로, 처리에 필요한 자료(퀴즈 · 풀이 기록 · 노트 글 등)는
    NestJS가 작업을 만들 때 input에 모두 담습니다. 작업별 내용은 6~8번 PR에서 정합니다.
  - result: NestJS가 읽어 quiz_sets 등에 반영합니다. 처리기는 다른 컬렉션에 쓰지 않습니다.
  - 앱의 '다시 시도'는 NestJS가 attempts=0 · status='queued' · retryAt=None으로 되돌려 넣습니다.
  - 색인(NestJS가 관리): {status: 1, type: 1, createdAt: 1}

잠금
  - 가져오기는 find_one_and_update 한 번이라, 처리기가 여럿이어도 같은 작업을 함께 가져가지
    않습니다.
  - 처리하는 동안 runner가 lockedUntil을 계속 늘립니다(진행률을 쓸 때도 늘림). lockedUntil이 지난
    running 작업은 처리기가 멈춘 것으로 보고 시도 한도 안에서 다시 가져갑니다.
  - 일시 오류로 다시 넣은 작업은 retryAt이 지나야 가져갑니다(lockedUntil과 따로 둠: 처리 중 취소된
    작업에 남은 잠금 시간이 다시 시도를 막지 않게).
  - 진행률 · 완료 · 실패는 status='running'이고 lockedBy가 나일 때만 씁니다. 그 사이 취소됐거나
    다른 처리기가 가져갔으면 JobGoneError를 올려 처리를 멈춥니다.
  - step은 공용 스키마에서 '없거나 문자열'이라, None을 쓰지 않고 필드를 지웁니다.
"""

from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from pymongo import ReturnDocument
from pymongo.collection import Collection

from app.clients.llm import JsonObject

SWEEP_EVERY = timedelta(seconds=60)  # 시도 한도를 넘긴 멈춘 작업 정리 간격(가져오기마다 하지 않음)


class JobGoneError(Exception):
    """작업이 취소됐거나 잠금이 다른 처리기로 넘어감: 더 쓰지 않고 멈춥니다."""


@dataclass(frozen=True)
class Job:
    id: Any  # ObjectId
    type: str
    input: object  # 처리 전에 객체인지 확인함(runner)
    attempts: int  # 이번 시도 포함


def _utcnow() -> datetime:
    return datetime.now(UTC)


class JobStore:
    def __init__(
        self,
        col: Collection[JsonObject],
        worker_id: str,
        *,
        lock_sec: int,
        max_attempts: int,
        retry_delay_sec: int,
        now: Callable[[], datetime] = _utcnow,
    ) -> None:
        self._col = col
        self._worker = worker_id
        self._lock = timedelta(seconds=lock_sec)
        self._max = max_attempts
        self._delay = timedelta(seconds=retry_delay_sec)
        self._now = now
        self._next_sweep: datetime | None = None

    @property
    def lock_sec(self) -> float:
        return self._lock.total_seconds()

    def claim(self, types: Iterable[str]) -> Job | None:
        """가장 먼저 들어온 작업 하나를 잠그고 가져옵니다. 없으면 None."""
        kinds = list(types)
        if not kinds:
            return None
        now = self._now()
        if self._next_sweep is None or now >= self._next_sweep:
            self._give_up_stalled(kinds, now)
            self._next_sweep = now + SWEEP_EVERY
        doc = self._col.find_one_and_update(
            {
                "type": {"$in": kinds},
                "$or": [
                    {"status": "queued", "$or": [{"retryAt": None}, {"retryAt": {"$lte": now}}]},
                    {
                        "status": "running",
                        "lockedUntil": {"$lte": now},
                        "attempts": {"$lt": self._max},
                    },
                ],
            },
            {
                "$set": {
                    "status": "running",
                    "progress": 0,  # 멈춘 작업을 다시 가져올 때 지난 시도의 진행률을 지움
                    "lockedBy": self._worker,
                    "lockedUntil": now + self._lock,
                    "retryAt": None,
                    "error": None,
                    "updatedAt": now,
                },
                "$inc": {"attempts": 1},
                "$unset": {"step": ""},
            },
            sort=[("createdAt", 1)],
            return_document=ReturnDocument.AFTER,
        )
        if doc is None:
            return None
        return Job(doc["_id"], doc["type"], doc.get("input"), int(doc["attempts"]))

    def _give_up_stalled(self, kinds: list[str], now: datetime) -> None:
        """시도 한도만큼 처리기가 멈춘 작업은 다시 가져가지 않고 실패로 둡니다."""
        self._col.update_many(
            {
                "type": {"$in": kinds},
                "status": "running",
                "lockedUntil": {"$lte": now},
                "attempts": {"$gte": self._max},
            },
            {
                "$set": {
                    "status": "failed",
                    "error": "처리가 끝나지 않음(시도 한도)",
                    "lockedBy": None,
                    "lockedUntil": None,
                    "updatedAt": now,
                },
                "$unset": {"step": ""},
            },
        )

    def touch(self, job: Job) -> None:
        """처리 중임을 알리고 잠금을 늘립니다(runner가 주기적으로 부름)."""
        now = self._now()
        self._write(job, {"$set": {"lockedUntil": now + self._lock, "updatedAt": now}})

    def progress(self, job: Job, value: int, step: str | None = None) -> None:
        """진행률(0~100)과 단계 이름을 쓰고 잠금을 늘립니다."""
        now = self._now()
        fields: JsonObject = {
            "progress": max(0, min(100, int(value))),
            "lockedUntil": now + self._lock,
            "updatedAt": now,
        }
        if step is not None:
            fields["step"] = step
        self._write(job, {"$set": fields})

    def succeed(self, job: Job, result: JsonObject) -> None:
        now = self._now()
        self._write(
            job,
            {
                "$set": {
                    "status": "succeeded",
                    "progress": 100,
                    "result": result,
                    "error": None,
                    "lockedBy": None,
                    "lockedUntil": None,
                    "updatedAt": now,
                },
                "$unset": {"step": ""},
            },
        )

    def fail(self, job: Job, error: str, *, retry: bool) -> str:
        """retry면 시도 한도까지 기다렸다가 다시 queued, 아니면 failed. 바뀐 상태를 돌려줍니다."""
        now = self._now()
        again = retry and job.attempts < self._max
        fields: JsonObject = {
            "status": "queued" if again else "failed",
            "error": error,
            "lockedBy": None,
            "lockedUntil": None,
            "retryAt": now + self._delay * job.attempts if again else None,
            "updatedAt": now,
        }
        if again:
            fields["progress"] = 0  # 실패로 끝나면 멈춘 곳의 진행률을 그대로 둠
        self._write(job, {"$set": fields, "$unset": {"step": ""}})
        return str(fields["status"])

    def _write(self, job: Job, update: JsonObject) -> None:
        r = self._col.update_one(
            {"_id": job.id, "status": "running", "lockedBy": self._worker}, update
        )
        if r.matched_count == 0:
            raise JobGoneError(str(job.id))
