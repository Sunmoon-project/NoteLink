"""작업 종류(ai_jobs.type) → 처리 함수.

처리기는 여기 등록된 종류만 가져가므로, 아직 만들지 않은 종류의 작업은 queued로 남습니다.
"""

import threading
from collections.abc import Callable

from app.clients.llm import JsonObject, Llm, LlmError, Metered, Paced, Spend, Stopping, make_llm
from app.clients.speech import Speech, SpeechUnavailableError, speech
from app.clients.voyage import EmbedUnavailableError, Voyage, voyage
from app.services.note import ask
from app.services.quiz import generate, review, today
from app.services.recording import job as recording_job
from app.worker.runner import Handler, JobInputError, JobReport


class _Once[T]:
    """처음 한 번 만든 것을 계속 돌려줍니다. 두 반복(스레드)이 처음 함께 불러도 하나만 만듦.

    functools.cache는 만들기를 잠그지 않아, 두 반복이 동시에 처음 부르면 LLM 클라이언트가 둘 생겨
    호출 간격 · 429 대기 · 사용자 우선이 나뉨(Codex 리뷰 #149). 만들다 실패하면 남기지 않습니다.
    """

    def __init__(self, make: Callable[[], T]) -> None:
        self._make = make
        self._made: list[T] = []
        self._lock = threading.Lock()

    def __call__(self) -> T:
        with self._lock:
            if not self._made:
                self._made.append(self._make())
            return self._made[0]

    def cache_clear(self) -> None:
        with self._lock:
            self._made.clear()


_spend: list[Spend] = []  # use_spend로 정함: 지금까지 쓴 Claude 비용(#298)


def use_spend(read_total: Callable[[], float]) -> None:
    """처리기가 시작할 때 부름: Claude 비용 합계를 읽는 법(ai_jobs.llmUsd).

    부르지 않으면 예산 제한 없음(시험 · 처리기 밖)."""
    _spend[:] = [Spend(read_total)]
    _llm.cache_clear()


@_Once
def _llm() -> Paced:
    """프로세스에 하나만 둡니다. LLM 호출 간격(LLM_CALL_GAP_SEC)을 작업 사이에도 지키게.

    Claude 비용이 CLAUDE_BUDGET_USD에 닿으면 학교 LLM으로 넘기는 연결(#298)."""
    return make_llm(_spend[0] if _spend else None)


@_Once
def _speech() -> Speech:
    return speech()


@_Once
def _voyage() -> Voyage:
    return voyage()


type _Run = Callable[[Llm, JsonObject, JobReport], JsonObject]


def _handler(run: _Run, *, background: bool = False) -> Handler:
    """퀴즈 서비스의 run을 처리 함수로. input 오류는 다시 해도 같으므로 바로 실패시킵니다.

    background면 LLM 호출 차례를 사용자 작업에 양보합니다(PacedLlm.background, #138).
    사용자가 이 작업을 이어받으면(report.awaited) 그때부터 양보하지 않습니다.
    작업이 취소되면(report.canceled) 남은 호출을 보내지 않습니다(Stopping, #263).
    """

    def handle(inp: JsonObject, report: JobReport) -> JsonObject:
        llm = _llm()
        conn: Llm = llm.background(report.awaited) if background else llm
        try:  # Claude 비용은 이 작업 문서에 쌓음(#298)
            return run(Stopping(Metered(conn, report.add_cost), report.canceled()), inp, report)
        except review.InputError as e:  # generate.NoQuestionsError는 code를 붙여 앱이 구분
            raise JobInputError(str(e), code=e.code) from e

    return handle


similar_quiz = _handler(review.run)  # 오답 복습
today_review = _handler(today.run)  # 오늘의 복습
quiz_generate = _handler(generate.run)  # 맞춤 퀴즈
note_ask = _handler(ask.run)  # 아바타 노트 묻고 답하기


def _pregen(llm: Llm, inp: JsonObject, report: JobReport) -> JsonObject:
    # 기다리는 사용자가 없어 안정적 모드(시간 상한 넉넉 · 단계를 더함, #274). 사용자가 이어받으면
    # (report.awaited) 그때부터 빠른 모드 · 보통 상한: 이어받은 채 시작해도 처음부터 빠른 모드라
    # 사용자 작업 반복을 오래 막지 않음(/code-review #138)
    return generate.run(llm, inp, report, mode=generate.STABLE, hurry=report.awaited)


# 노트를 만들 때 미리 만드는 첫 맞춤 퀴즈(#134). 안정적 모드로 만들고 LLM 차례를 양보(#138)
quiz_pregen = _handler(_pregen, background=True)


def recording_summary(inp: JsonObject, report: JobReport) -> JsonObject:
    """녹음 정리(recording_job.run). 일시 오류는 LlmError로 바꿔 시도 한도 안에서 다시 시도합니다.

    설정 누락 · 음성 외 영구 오류는 그 밖의 예외로 두어 바로 실패합니다(자세한 내용은 로그에만).
    LLM 설정(키 · 주소)이 비어 있으면 _llm()이 LlmSetupError(retry=False)로 바로 실패시킵니다(#262).
    작업이 취소되면 남은 LLM 호출을 보내지 않습니다(#263). 음성 인식은 한 번의 긴 호출이라
    보낸 뒤에는 멈추지 못합니다.
    """
    llm = Stopping(Metered(_llm(), report.add_cost), report.canceled())
    try:
        return recording_job.run(llm, _speech, _voyage(), inp, report, checkpoint=report)
    except recording_job.InputError as e:
        raise JobInputError(str(e), code=e.code) from e
    except SpeechUnavailableError as e:
        raise LlmError(f"음성 인식 {e}") from e
    except EmbedUnavailableError as e:
        raise LlmError(f"임베딩 {e}") from e


HANDLERS: dict[str, Handler] = {
    review.TYPE: similar_quiz,
    today.TYPE: today_review,
    generate.TYPE: quiz_generate,
    recording_job.TYPE: recording_summary,
}
# 목록 밖에서 더해 다른 종류 추가와 줄이 겹치지 않게 둡니다.
HANDLERS[generate.PREGEN_TYPE] = quiz_pregen
HANDLERS[ask.TYPE] = note_ask
# 사용자 작업과 따로 도는 반복이 하나씩 처리하는 종류(__main__ · runner.run_lanes, #138)
BACKGROUND: frozenset[str] = frozenset({generate.PREGEN_TYPE})
