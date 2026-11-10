"""ai_jobs 처리 반복: 처리 함수가 등록된 작업 종류만 가져와 처리합니다.

처리 함수(Handler)는 input을 받아 result를 돌려주고, 진행률은 report(값, 단계)로 알립니다.
시도 사이에 다시 쓸 중간 결과는 report.save_checkpoint · load_checkpoint로 저장하고 읽습니다.
  - LlmError        일시 오류 → 시도 한도까지 기다렸다가 다시 시도
  - LlmRejectedError  학교 LLM이 이 요청을 거절함(400 등) → 바로 실패(다시 보내도 같음, #262)
  - LlmSetupError   학교 LLM 설정 오류 → e.retry면 시도 한도까지 다시(서버가 거절), 아니면 바로 실패
                    (설정 값이 비어 있음, #262)
  - JobInputError   input이 작업에 맞지 않음 → 바로 실패(다시 해도 같음). 오류 문구는 code로 시작
  - 그 밖의 예외    코드 오류 → 바로 실패. 오류 문구는 앱에 보이므로 자세한 내용은 로그에만 남김
  - JobGoneError    취소됐거나 잠금을 잃음 → 아무것도 쓰지 않고 다음 작업으로
  - PyMongoError    DB 연결 문제 → 쓰지 않고 둠. 잠금이 끝나면 다시 가져감(시도 한도 안에서)

처리 함수가 도는 동안 따로 도는 스레드가 잠금을 늘립니다(잠금 시간의 1/3마다). 진행률을 한동안
쓰지 않는 긴 LLM 호출 중에도 다른 처리기가 같은 작업을 가져가지 않게 합니다.

취소(#263): 같은 스레드가 CANCEL_CHECK_SEC마다 작업이 아직 내 것(running · lockedBy 나)인지
읽습니다. 아니면(NestJS가 canceled로 바꿈 · 다른 처리기가 가져감) report.canceled()를 켜고,
처리 함수는 그 신호로 남은 학교 LLM 호출을 보내지 않습니다(llm.Stopping). 처리 함수가 끝난 뒤
취소된 작업의 내 잠금을 풀어 앱의 '다시 시도'가 잠금이 끝나기를 기다리지 않게 합니다
(JobStore.release). 처리 중에는 풀지 않습니다: 다시 넣은 작업을 다른 처리기가 가져가 같은 작업을
둘이 함께 만들지 않게.

반복(Lane)은 여럿 둘 수 있습니다(run_lanes). 한 반복은 작업을 하나씩 처리하므로, 오래 걸리는
미리 만들기(quiz_pregen)는 따로 돌려 사용자 작업을 막지 않게 합니다(#138).
"""

import logging
import threading
import time
from collections.abc import Callable, Collection, Mapping, Sequence
from dataclasses import dataclass
from typing import Protocol

from pymongo.errors import PyMongoError

from app.clients.llm import JsonObject, LlmError, LlmRejectedError, LlmSetupError
from app.worker.jobs import Job, JobGoneError, JobStore

log = logging.getLogger(__name__)


class JobInputError(ValueError):
    """input이 작업에 맞지 않음(빠진 필드 · 잘못된 형식). 메시지는 앱에 보이는 짧은 원인.

    code가 있으면 앱이 구분할 수 있게 ai_jobs.error를 '<code>: <원인>'으로 씁니다.
    """

    def __init__(self, message: str, *, code: str | None = None) -> None:
        super().__init__(message)
        self.code = code


class Report(Protocol):
    def __call__(self, value: int, step: str | None = None) -> None: ...


class JobReport(Report, Protocol):
    """Report에 중간 결과 저장을 더한 것. Report만 받는 처리 함수도 그대로 Handler가 됩니다."""

    def load_checkpoint(self) -> object: ...

    def save_checkpoint(self, value: JsonObject) -> None: ...

    def awaited(self) -> bool:
        """사용자가 이 작업을 이어받았는지(미리 해 두는 작업, #138)."""
        ...

    def canceled(self) -> threading.Event:
        """작업이 취소됐거나 잠금을 잃은 것을 처리기가 알아채면 켜짐(#263)."""
        ...


AWAITED_CHECK_SEC = 5.0  # 처리 중인 작업의 awaited를 DB에서 다시 읽는 간격
CANCEL_CHECK_SEC = 5.0  # 처리 중인 작업이 취소됐는지 DB에서 다시 읽는 간격(#263)

type Handler = Callable[[JsonObject, JobReport], JsonObject]


class _StoreReport:
    def __init__(
        self,
        store: JobStore,
        job: Job,
        *,
        canceled: threading.Event | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._store, self._job, self._clock = store, job, clock
        self._canceled = canceled or threading.Event()
        self._awaited = job.awaited
        self._checked = clock()
        self._lock = threading.Lock()  # 미리 만들기는 여러 스레드에서 부름

    def __call__(self, value: int, step: str | None = None) -> None:
        self._store.progress(self._job, value, step)

    def load_checkpoint(self) -> object:
        return self._job.checkpoint

    def save_checkpoint(self, value: JsonObject) -> None:
        self._store.save_checkpoint(self._job, value)

    def awaited(self) -> bool:
        """한 번 참이면 계속 참. DB는 AWAITED_CHECK_SEC에 한 번만 읽고, 못 읽으면 지난 값.

        읽는 동안 다른 스레드는 기다리지 않고 지난 값을 씁니다: DB가 느리면 퀴즈 자리 스레드가
        모두 멈춰 멈춤 신호 · 시간 상한을 보지 못함(/code-review #138).
        """
        if self._awaited or self._clock() - self._checked < AWAITED_CHECK_SEC:
            return self._awaited
        if not self._lock.acquire(blocking=False):
            return self._awaited  # 다른 스레드가 읽는 중
        try:
            if self._clock() - self._checked >= AWAITED_CHECK_SEC:
                self._checked = self._clock()
                self._awaited = self._store.awaited(self._job)
        except PyMongoError:
            log.warning("작업 %s: awaited 읽기 실패, 다음에 다시", self._job.id)
        finally:
            self._lock.release()
        return self._awaited

    def canceled(self) -> threading.Event:
        return self._canceled


class _Heartbeat:
    """with 블록이 도는 동안 every초마다 잠금을 늘리고, check초마다 작업이 아직 내 것인지 봅니다.

    내 것이 아니면(취소됨 · 다른 처리기가 가져감) canceled를 켜고 멈춥니다(#263). 전에는 잠금을
    늘릴 때(기본 300초마다)나 처리 함수가 다음에 쓸 때에야 알았음.
    """

    def __init__(
        self,
        store: JobStore,
        job: Job,
        every: float,
        canceled: threading.Event,
        *,
        check: float | None = None,
    ) -> None:
        self._store, self._job, self._every = store, job, every
        self._check = check or CANCEL_CHECK_SEC
        self._canceled = canceled
        self._done = threading.Event()
        self._thread = threading.Thread(target=self._run, name=f"heartbeat-{job.id}", daemon=True)

    def _run(self) -> None:
        touched = time.monotonic()
        # 잠금 연장 시각을 넘겨 기다리지 않음: 상태 읽기 간격 때문에 연장이 늦어지면 잠금이 끝나
        # 다른 처리기가 처리 중인 작업을 가져갈 수 있음(/code-review #263)
        while not self._done.wait(
            max(0.0, min(self._check, touched + self._every - time.monotonic()))
        ):
            try:
                if time.monotonic() - touched >= self._every:
                    self._store.touch(self._job)
                    touched = time.monotonic()
                elif not self._store.holds(self._job):
                    raise JobGoneError(str(self._job.id))
            except JobGoneError:
                log.info(
                    "작업 %s: 취소됐거나 다른 처리기로 넘어감, 남은 LLM 호출을 멈춤", self._job.id
                )
                self._canceled.set()
                return
            except PyMongoError:
                # 상태 읽기는 몇 초마다라 DB가 끊긴 동안 경고가 쌓이지 않게 잠금 연장 실패만 경고
                late = time.monotonic() - touched >= self._every
                (log.warning if late else log.debug)(
                    "작업 %s: 잠금 연장 · 상태 읽기 실패, 다음에 다시", self._job.id
                )

    def __enter__(self) -> None:
        self._thread.start()

    def __exit__(self, *exc: object) -> None:
        self._done.set()
        self._thread.join()


def run_once(
    store: JobStore,
    handlers: Mapping[str, Handler],
    *,
    awaited_only: Collection[str] = (),
    heartbeat_sec: float | None = None,
) -> bool:
    """작업 하나를 가져와 처리합니다. 할 일이 없었으면 False.

    awaited_only에 든 종류는 사용자가 이어받은(awaited) 작업만 가져갑니다(#138).
    """
    job = store.claim([t for t in handlers if t not in awaited_only], awaited_only)
    if job is None:
        return False

    canceled = threading.Event()
    try:
        if not isinstance(job.input, dict):
            raise JobInputError("input이 객체가 아님")
        every = heartbeat_sec or store.lock_sec / 3
        with _Heartbeat(store, job, every, canceled):
            result = handlers[job.type](job.input, _StoreReport(store, job, canceled=canceled))
        store.succeed(job, result)
        log.info("작업 완료 %s (%s)", job.id, job.type)
    except JobGoneError:
        log.info("작업이 취소됐거나 다른 처리기로 넘어감 %s", job.id)
        _release(store, job)
    except LlmRejectedError as e:
        log.warning("작업 %s: 학교 LLM이 요청을 거절함 %s", job.id, e)
        _fail(store, job, f"AI가 요청을 거절함({e})", retry=False)
    except LlmError as e:
        log.warning("작업 %s: LLM 오류 %s", job.id, e)
        _fail(store, job, f"AI 응답을 받지 못함({e})", retry=True)
    except LlmSetupError as e:
        log.error("작업 %s: 학교 LLM 설정 오류 %s — 키 · 주소 · 모델 이름 확인", job.id, e)
        _fail(store, job, f"AI 설정 오류({e})", retry=e.retry)
    except JobInputError as e:
        log.warning("작업 %s: 입력 오류 %s", job.id, e)
        _fail(store, job, f"{e.code}: {e}" if e.code else f"입력 오류: {e}", retry=False)
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
        _release(store, job)


def _release(store: JobStore, job: Job) -> None:
    """처리 함수가 끝난 뒤: 취소된 작업이면 내 잠금을 풀어 '다시 시도'가 바로 되게(#263)."""
    try:
        if store.release(job):
            log.info("작업 %s: 취소된 작업의 잠금을 풂", job.id)
    except PyMongoError:
        log.warning("작업 %s: 잠금 풀기 실패(잠금이 끝나면 다시 시도할 수 있음)", job.id)


def run_forever(
    store: JobStore,
    handlers: Mapping[str, Handler],
    *,
    poll_sec: float,
    stop: threading.Event,
    awaited_only: Collection[str] = (),
) -> None:
    """stop이 켜질 때까지 반복합니다. 처리 중인 작업은 끝까지 처리한 뒤 멈춥니다."""
    while not stop.is_set():
        try:
            busy = run_once(store, handlers, awaited_only=awaited_only)
        except PyMongoError:
            # DB 연결이 끊김: 쓰지 못한 작업은 잠금이 끝나면 다시 가져가므로 기다렸다 계속
            log.exception("ai_jobs 처리 중 DB 오류")
            busy = False
        if not busy:
            stop.wait(poll_sec)


@dataclass(frozen=True)
class Lane:
    """따로 도는 처리 반복 하나: 이 store로 handlers에 든 종류만 가져가 하나씩 처리합니다.

    awaited_only에 든 종류는 사용자가 이어받은 작업만 가져갑니다(#138).
    """

    name: str
    store: JobStore
    handlers: Mapping[str, Handler]
    awaited_only: frozenset[str] = frozenset()


def run_lanes(lanes: Sequence[Lane], *, poll_sec: float, stop: threading.Event) -> None:
    """반복마다 run_forever를 따로 돌리고, 모두 멈출 때까지 기다립니다.

    마지막 반복은 이 스레드에서 돌려 멈춤 신호를 지금처럼 받습니다. 한 반복이 뜻밖의 오류로
    끝나면 stop을 켜 나머지도 지금 작업을 끝낸 뒤 멈추게 하고, 그 오류를 올립니다(처리기를
    다시 띄우게).
    """
    errors: list[BaseException] = []

    def lane_loop(lane: Lane) -> None:
        try:
            run_forever(
                lane.store,
                lane.handlers,
                poll_sec=poll_sec,
                stop=stop,
                awaited_only=lane.awaited_only,
            )
        except BaseException as e:
            log.exception("처리 반복 %s이 멈춤", lane.name)
            errors.append(e)
        finally:
            stop.set()  # 한 반복이 끝나면 나머지도 지금 작업을 끝낸 뒤 멈춤

    active = [lane for lane in lanes if lane.handlers]
    if not active:  # 등록된 종류가 없음: 바로 끝나 다시 띄우기를 되풀이하지 않게 멈춤 신호까지 둠
        while not stop.wait(poll_sec):
            pass
        return
    *others, last = active
    threads = [
        threading.Thread(target=lane_loop, args=(lane,), name=f"lane-{lane.name}", daemon=True)
        for lane in others
    ]
    for t in threads:
        t.start()
    try:
        lane_loop(last)
    finally:
        for t in threads:
            t.join()
    if errors:
        raise errors[0]
