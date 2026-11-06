"""작업 종류(ai_jobs.type) → 처리 함수.

처리기는 여기 등록된 종류만 가져가므로, 아직 만들지 않은 종류의 작업은 queued로 남습니다.
"""

from collections.abc import Callable
from functools import cache

from app.clients.llm import JsonObject, Llm, LlmError, SchoolLlm, school_llm
from app.clients.speech import Speech, SpeechUnavailableError, speech
from app.clients.voyage import EmbedUnavailableError, Voyage, voyage
from app.services.quiz import generate, review, today
from app.services.recording import job as recording_job
from app.worker.runner import Handler, JobInputError, JobReport, Report


@cache
def _llm() -> SchoolLlm:
    """프로세스에 하나만 둡니다. 학교 LLM 호출 간격(llm_call_gap_sec)을 작업 사이에도 지키게."""
    return school_llm()


@cache
def _speech() -> Speech:
    return speech()


@cache
def _voyage() -> Voyage:
    return voyage()


type _Run = Callable[[Llm, JsonObject, Report], JsonObject]


def _handler(run: _Run) -> Handler:
    """퀴즈 서비스의 run을 처리 함수로. input 오류는 다시 해도 같으므로 바로 실패시킵니다."""

    def handle(inp: JsonObject, report: Report) -> JsonObject:
        try:
            return run(_llm(), inp, report)
        except review.InputError as e:
            raise JobInputError(str(e)) from e

    return handle


similar_quiz = _handler(review.run)  # 오답 복습
today_review = _handler(today.run)  # 오늘의 복습
quiz_generate = _handler(generate.run)  # 맞춤 퀴즈


def recording_summary(inp: JsonObject, report: JobReport) -> JsonObject:
    """녹음 정리(recording_job.run). 일시 오류는 LlmError로 바꿔 시도 한도 안에서 다시 시도합니다.

    설정 누락 · 음성 외 영구 오류는 그 밖의 예외로 두어 바로 실패합니다(자세한 내용은 로그에만).
    """
    try:
        llm = _llm()
    except LlmError as e:
        raise RuntimeError(str(e)) from e  # runner가 LlmError를 다시 시도하지 않게
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
# 노트를 만들 때 미리 만드는 첫 맞춤 퀴즈(#134). 처리는 맞춤 퀴즈와 같고 가져가는 순서만 나중입니다.
# 목록 밖에서 더해 녹음 정리(#118) 등 다른 종류 추가와 줄이 겹치지 않게 둡니다.
HANDLERS[generate.PREGEN_TYPE] = quiz_generate
# 사용자가 기다리는 작업이 없을 때만 가져가는 종류(jobs.JobStore.claim)
LATER: frozenset[str] = frozenset({generate.PREGEN_TYPE})
