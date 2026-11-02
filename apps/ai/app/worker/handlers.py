"""작업 종류(ai_jobs.type) → 처리 함수. 7 · 8번 PR(오늘의 복습 · 맞춤 퀴즈)에서 더 채웁니다.

처리기는 여기 등록된 종류만 가져가므로, 아직 만들지 않은 종류의 작업은 queued로 남습니다.
"""

from functools import cache

from app.clients.llm import JsonObject, SchoolLlm, school_llm
from app.services.quiz import review
from app.worker.runner import Handler, JobInputError, Report


@cache
def _llm() -> SchoolLlm:
    """프로세스에 하나만 둡니다. 학교 LLM 호출 간격(llm_call_gap_sec)을 작업 사이에도 지키게."""
    return school_llm()


def similar_quiz(inp: JsonObject, report: Report) -> JsonObject:
    """오답 복습(review.run). input 오류는 다시 해도 같으므로 JobInputError로 바로 실패시킵니다."""
    try:
        return review.run(_llm(), inp, report)
    except review.InputError as e:
        raise JobInputError(str(e)) from e


HANDLERS: dict[str, Handler] = {review.TYPE: similar_quiz}
