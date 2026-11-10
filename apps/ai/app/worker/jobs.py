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
                 awaited(미리 해 두는 작업을 사용자가 이어받을 때 true, #138)
  처리기가 씀    status · progress · step · attempts · result · error · checkpoint
                 lockedBy · lockedUntil · retryAt · updatedAt
                 (NestJS도 바꿈: 취소 · 다시 시도. 이어받기는 awaited만, 아래 「가져오는 순서」)
  - input: 처리기는 다른 컬렉션을 읽지 않으므로, 처리에 필요한 자료(퀴즈 · 풀이 기록 · 노트 글 등)는
    NestJS가 작업을 만들 때 input에 모두 담습니다. 작업별 내용은 6~8번 PR에서 정합니다.
  - result: NestJS가 읽어 quiz_sets 등에 반영합니다. 처리기는 다른 컬렉션에 쓰지 않습니다.
  - 앱의 '다시 시도'는 NestJS가 attempts=0 · status='queued' · retryAt=None으로 되돌려 넣습니다.
  - checkpoint: 처리기 내부용. 시도 사이에 다시 쓸 중간 결과입니다. 처리 함수가 저장하고, 성공할 때
    지웁니다. 실패로 끝나도 남겨 앱의 '다시 시도'에서 다시 씁니다. NestJS는 읽지 않습니다.
  - 색인(NestJS가 관리): {status: 1, type: 1, createdAt: 1}

가져오는 순서
  - 가져올 종류(types) 중 들어온 순서대로 가져갑니다.
  - 미리 해 두는 작업(노트를 만들 때 넣는 퀴즈 미리 만들기 quiz_pregen)은 사용자가 기다리는
    작업과 따로 도는 반복이 가져갑니다(runner.run_lanes, #138). 미리 만들기를 처리하는 중에도
    사용자 작업은 바로 시작하고, LLM 호출 차례는 사용자 작업이 먼저 가져갑니다
    (PacedLlm.background). 그래서 미리 만들기가 먼저 들어왔어도 사용자가 그 뒤로 밀리지 않음
  - 같은 노트의 미리 만들기가 아직 끝나지 않았을 때 사용자가 퀴즈를 요청하면, NestJS는 새 작업을
    넣지 않고(넣으면 같은 퀴즈를 두 번 만듦) 그 작업에 awaited=true를 씁니다(#138).
    - queued면 사용자 작업 반복도 가져갑니다(claim의 awaited_types). 다른 미리 만들기 뒤에서
      기다리지 않게
    - 처리 중이면 처리기가 AWAITED_CHECK_SEC마다 읽어(awaited) LLM 호출 차례를 양보하지
      않습니다. 시간 상한은 시작할 때 정해서, 처리 중에 이어받으면 미리 만들기 상한 그대로입니다
    - NestJS는 AiJobsService.takeOverPregen(apps/api, #175)에서 awaited만 씁니다. 잠금이 지난
      running(처리기 멈춤)도 이어받고 처리기 상태는 바꾸지 않습니다. 시도가 남았으면 처리기가
      다시 가져가고, 다 썼으면 failed가 되어 앱의 '다시 시도'로 다시 넣습니다
  - 알려진 한계(/code-review #134)
    - 사용자 작업이 끊이지 않으면 미리 해 두는 작업은 queued로 남습니다. 오래된 것은 NestJS가
      canceled로 바꿉니다(처리 중이면 처리기가 결과를 버림)

잠금
  - 가져오기는 find_one_and_update 한 번이라, 처리기가 여럿이어도 같은 작업을 함께 가져가지
    않습니다.
  - 처리하는 동안 runner가 lockedUntil을 계속 늘립니다(진행률을 쓸 때도 늘림). lockedUntil이 지난
    running 작업은 처리기가 멈춘 것으로 보고 시도 한도 안에서 다시 가져갑니다.
  - 일시 오류로 다시 넣은 작업은 retryAt이 지나야 가져갑니다(lockedUntil과 따로 둠: 처리 중 취소된
    작업에 남은 잠금 시간이 다시 시도를 막지 않게).
  - 진행률 · 완료 · 실패는 status='running'이고 lockedBy가 나일 때만 씁니다. 그 사이 취소됐거나
    다른 처리기가 가져갔으면 JobGoneError를 올려 처리를 멈춥니다.
  - 처리하는 동안 runner가 몇 초마다 작업이 아직 내 것인지 읽어(holds) 취소를 알아채고, 처리 함수가
    끝난 뒤 취소된 작업의 내 잠금을 풉니다(release, #263). NestJS의 '다시 시도'가 잠금이 끝나기를
    기다리지 않게.
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
    checkpoint: object = None  # 지난 시도가 저장한 값. 쓰기 전에 처리 함수가 확인함
    awaited: bool = False  # 가져갈 때 이미 사용자가 이어받았음(#138)


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

    def claim(self, types: Iterable[str], awaited_types: Iterable[str] = ()) -> Job | None:
        """작업 하나를 잠그고 가져옵니다. 없으면 None.

        awaited_types 중 사용자가 이어받은(awaited) 작업이 있으면 그중 가장 먼저 들어온 것(노트를
        만들 때부터 기다린 사용자), 없으면 types 중 가장 먼저 들어온 것. 질의를 나눠 각각
        색인({status, type, createdAt})을 그대로 탐(/code-review #138).
        """
        kinds = list(types)
        awaited = [t for t in awaited_types if t not in kinds]
        if not kinds and not awaited:
            return None
        now = self._now()
        if self._next_sweep is None or now >= self._next_sweep:
            self._give_up_stalled(kinds + awaited, now)
            self._next_sweep = now + SWEEP_EVERY
        if awaited:
            job = self._claim({"type": {"$in": awaited}, "awaited": True}, now)
            if job is not None:
                return job
        return self._claim({"type": {"$in": kinds}}, now) if kinds else None

    def awaited(self, job: Job) -> bool:
        """처리 중인 작업을 사용자가 이어받았는지(NestJS가 awaited=true를 씀)."""
        return self._col.find_one({"_id": job.id, "awaited": True}, {"_id": 1}) is not None

    def _claim(self, which: JsonObject, now: datetime) -> Job | None:
        doc = self._col.find_one_and_update(
            {
                **which,  # 종류 조건(type · awaited). $or는 아래 상태 조건만 씀
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
        return Job(
            doc["_id"],
            doc["type"],
            doc.get("input"),
            int(doc["attempts"]),
            doc.get("checkpoint"),
            doc.get("awaited") is True,
        )

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

    def holds(self, job: Job) -> bool:
        """작업이 아직 내 것인지(running이고 lockedBy가 나). 읽기만 함(runner가 취소를 봄, #263)."""
        doc = self._col.find_one(
            {"_id": job.id, "status": "running", "lockedBy": self._worker}, {"_id": 1}
        )
        return doc is not None

    def release(self, job: Job) -> bool:
        """취소된 작업의 내 잠금을 풉니다. 풀었으면 True(#263).

        NestJS의 '다시 시도'는 잠금이 끝난 작업만 다시 넣으므로(처리 중 취소한 작업을 두 처리기가
        함께 만들지 않게), 처리 함수가 끝난 뒤에 풀어 바로 다시 넣을 수 있게 합니다. 그사이 다시
        넣었거나 다른 처리기가 가져갔으면 바꾸지 않습니다.
        """
        r = self._col.update_one(
            {"_id": job.id, "status": "canceled", "lockedBy": self._worker},
            {"$set": {"lockedBy": None, "lockedUntil": None, "updatedAt": self._now()}},
        )
        return r.modified_count > 0

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

    def save_checkpoint(self, job: Job, value: JsonObject) -> None:
        """다음 시도에 다시 쓸 중간 결과를 저장하고 잠금을 늘립니다."""
        now = self._now()
        self._write(
            job,
            {"$set": {"checkpoint": value, "lockedUntil": now + self._lock, "updatedAt": now}},
        )

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
                "$unset": {"step": "", "checkpoint": ""},
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
