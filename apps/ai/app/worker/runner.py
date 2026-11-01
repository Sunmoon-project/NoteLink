"""ai_jobs 처리 반복: 처리 함수가 등록된 작업 종류만 가져와 처리합니다.

처리 함수(Handler)는 input을 받아 result를 돌려주고, 진행률은 report(값, 단계)로 알립니다.
  - LlmError        일시 오류 → 시도 한도까지 기다렸다가 다시 시도
  - JobInputError   input이 작업에 맞지 않음 → 바로 실패(다시 해도 같음)
  - 그 밖의 예외    코드 오류 → 바로 실패. 오류 문구는 앱에 보이므로 자세한 내용은 로그에만 남김
  - JobGoneError    취소됐거나 잠금을 잃음 → 아무것도 쓰지 않고 다음 작업으로
  - PyMongoError    DB 연결 문제 → 쓰지 않고 둠. 잠금이 끝나면 다시 가져감(시도 한도 안에서)

처리 함수가 도는 동안 따로 도는 스레드가 잠금을 늘립니다(잠금 시간의 1/3마다). 진행률을 한동안
쓰지 않는 긴 LLM 호출 중에도 다른 처리기가 같은 작업을 가져가지 않게 합니다.
"""

import logging
import threading
from collections.abc import Callable, Mapping
from typing import Protocol

from pymongo.errors import PyMongoError

from app.clients.llm import JsonObject, LlmError
from app.worker.jobs import Job, JobGoneError, JobStore

log = logging.getLogger(__name__)


class JobInputError(ValueError):
    """input이 작업에 맞지 않음(빠진 필드 · 잘못된 형식). 메시지는 앱에 보이는 짧은 원인."""


class Report(Protocol):
    def __call__(self, value: int, step: str | None = None) -> None: ...


type Handler = Callable[[JsonObject, Report], JsonObject]


class _Heartbeat:
    """with 블록이 도는 동안 every초마다 잠금을 늘립니다."""

    def __init__(self, store: JobStore, job: Job, every: float) -> None:
        self._store, self._job, self._every = store, job, every
        self._done = threading.Event()
        self._thread = threading.Thread(target=self._run, name=f"heartbeat-{job.id}", daemon=True)

    def _run(self) -> None:
        while not self._done.wait(self._every):
            try:
                self._store.touch(self._job)
            except JobGoneError:
                return  # 취소됨: 다음 report() · 완료 쓰기에서 처리를 멈춤
            except PyMongoError:
                log.warning("작업 %s: 잠금 연장 실패, 다음에 다시", self._job.id)

    def __enter__(self) -> None:
        self._thread.start()

    def __exit__(self, *exc: object) -> None:
        self._done.set()
        self._thread.join()


def run_once(
    store: JobStore, handlers: Mapping[str, Handler], *, heartbeat_sec: float | None = None
) -> bool:
    """작업 하나를 가져와 처리합니다. 할 일이 없었으면 False."""
    job = store.claim(handlers)
    if job is None:
        return False

    def report(value: int, step: str | None = None) -> None:
        store.progress(job, value, step)

    try:
        if not isinstance(job.input, dict):
            raise JobInputError("input이 객체가 아님")
        with _Heartbeat(store, job, heartbeat_sec or store.lock_sec / 3):
            result = handlers[job.type](job.input, report)
        store.succeed(job, result)
        log.info("작업 완료 %s (%s)", job.id, job.type)
    except JobGoneError:
        log.info("작업이 취소됐거나 다른 처리기로 넘어감 %s", job.id)
    except LlmError as e:
        log.warning("작업 %s: LLM 오류 %s", job.id, e)
        _fail(store, job, f"AI 응답을 받지 못함({e})", retry=True)
    except JobInputError as e:
        log.warning("작업 %s: 입력 오류 %s", job.id, e)
        _fail(store, job, f"입력 오류: {e}", retry=False)
    except PyMongoError:
        raise  # 실패로 쓰지 않음: run_forever가 기록하고, 잠금이 끝나면 다시 가져감
    except Exception:
        log.exception("작업 %s (%s) 처리 중 오류", job.id, job.type)
        _fail(store, job, "처리 중 오류", retry=False)
    return True


def _fail(store: JobStore, job: Job, error: str, *, retry: bool) -> None:
    try:
        log.info("작업 %s → %s", job.id, store.fail(job, error, retry=retry))
    except JobGoneError:
        log.info("작업이 취소됐거나 다른 처리기로 넘어감 %s", job.id)


def run_forever(
    store: JobStore,
    handlers: Mapping[str, Handler],
    *,
    poll_sec: float,
    stop: threading.Event,
) -> None:
    """stop이 켜질 때까지 반복합니다. 처리 중인 작업은 끝까지 처리한 뒤 멈춥니다."""
    while not stop.is_set():
        try:
            busy = run_once(store, handlers)
        except PyMongoError:
            # DB 연결이 끊김: 쓰지 못한 작업은 잠금이 끝나면 다시 가져가므로 기다렸다 계속
            log.exception("ai_jobs 처리 중 DB 오류")
            busy = False
        if not busy:
            stop.wait(poll_sec)
