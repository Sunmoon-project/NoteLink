from fastapi import FastAPI

from app.api.v1 import health, images
from app.core.config import settings

# AI 서버는 외부에 공개하지 않는 내부 API입니다. 자동 문서(/docs)는 개발 환경에서만 켭니다.
app = FastAPI(
    title="NoteLink AI",
    openapi_url=None if settings.is_production else "/openapi.json",
)
app.include_router(health.router, prefix="/internal/v1")
app.include_router(images.router, prefix="/internal/v1")
