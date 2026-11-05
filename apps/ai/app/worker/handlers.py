"""작업 종류(ai_jobs.type) → 처리 함수. 8번 PR(맞춤 퀴즈)에서 더 채웁니다.

처리기는 여기 등록된 종류만 가져가므로, 아직 만들지 않은 종류의 작업은 queued로 남습니다.
"""

from collections.abc import Callable
from functools import cache

from app.clients.llm import JsonObject, Llm, SchoolLlm, school_llm
from app.services.quiz import review, today
from app.worker.runner import Handler, JobInputError, Report


@cache
def _llm() -> SchoolLlm:
    """프로세스에 하나만 둡니다. 학교 LLM 호출 간격(llm_call_gap_sec)을 작업 사이에도 지키게."""
    return school_llm()


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

HANDLERS: dict[str, Handler] = {review.TYPE: similar_quiz, today.TYPE: today_review}
