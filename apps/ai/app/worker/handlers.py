"""작업 종류(ai_jobs.type) → 처리 함수. 7 · 8번 PR(오늘의 복습 · 맞춤 퀴즈)에서 더 채웁니다.

처리기는 여기 등록된 종류만 가져가므로, 아직 만들지 않은 종류의 작업은 queued로 남습니다.
"""

from functools import cache

from app.clients.llm import JsonObject, LlmError, SchoolLlm, school_llm
from app.clients.speech import Speech, SpeechUnavailableError, speech
from app.clients.voyage import EmbedUnavailableError, Voyage, voyage
from app.services.quiz import review
from app.services.recording import job as recording_job
from app.worker.runner import Handler, JobInputError, Report


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


def similar_quiz(inp: JsonObject, report: Report) -> JsonObject:
    """오답 복습(review.run). input 오류는 다시 해도 같으므로 JobInputError로 바로 실패시킵니다."""
    try:
        return review.run(_llm(), inp, report)
    except review.InputError as e:
        raise JobInputError(str(e)) from e


def recording_summary(inp: JsonObject, report: Report) -> JsonObject:
    """녹음 정리(recording_job.run). 일시 오류는 LlmError로 바꿔 시도 한도 안에서 다시 시도합니다.

    설정 누락 · 음성 외 영구 오류는 그 밖의 예외로 두어 바로 실패합니다(자세한 내용은 로그에만).
    """
    try:
        llm = _llm()
    except LlmError as e:
        raise RuntimeError(str(e)) from e  # runner가 LlmError를 다시 시도하지 않게
    try:
        return recording_job.run(llm, _speech, _voyage(), inp, report)
    except recording_job.InputError as e:
        raise JobInputError(str(e), code=e.code) from e
    except SpeechUnavailableError as e:
        raise LlmError(f"음성 인식 {e}") from e
    except EmbedUnavailableError as e:
        raise LlmError(f"임베딩 {e}") from e


HANDLERS: dict[str, Handler] = {
    review.TYPE: similar_quiz,
    recording_job.TYPE: recording_summary,
}
