"""작업 종류(ai_jobs.type) → 처리 함수. 6~8번 PR(오답 복습 · 오늘의 복습 · 맞춤 퀴즈)에서 채웁니다.

처리기는 여기 등록된 종류만 가져가므로, 아직 만들지 않은 종류의 작업은 queued로 남습니다.
"""

from app.worker.runner import Handler

HANDLERS: dict[str, Handler] = {}
