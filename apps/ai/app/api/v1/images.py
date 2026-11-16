"""NestJS 내부에서 호출하는 학습자료 이미지 사전 검사."""

from collections.abc import Callable
from secrets import compare_digest
from typing import Annotated, Any

from fastapi import APIRouter, Header, HTTPException
from pydantic import AnyHttpUrl, BaseModel, Field, StringConstraints

from app.clients.docint import Ocr, OcrError, OcrSetupError, OcrUnavailableError, docint
from app.core.config import settings
from app.services.image_check import ImageVerdict, verdict_from_read

router = APIRouter()
MAX_FILES = 20


class ImageCheckFile(BaseModel):
    name: Annotated[str, StringConstraints(min_length=1, max_length=255)]
    uri: AnyHttpUrl


class ImageCheckRequest(BaseModel):
    files: Annotated[list[ImageCheckFile], Field(min_length=1, max_length=MAX_FILES)]


class ImageCheckResult(BaseModel):
    name: str
    verdict: ImageVerdict


def _authorize(authorization: str | None) -> None:
    expected = settings.ai_internal_token.get_secret_value()
    if not expected:
        raise HTTPException(status_code=503, detail="Internal service is not configured")
    supplied = authorization.removeprefix("Bearer ") if authorization else ""
    if not authorization or not authorization.startswith("Bearer ") or not compare_digest(supplied, expected):
        raise HTTPException(status_code=401, detail="Unauthorized")


def _check(files: list[ImageCheckFile], make_ocr: Callable[[], Ocr]) -> list[ImageCheckResult]:
    try:
        reader = make_ocr()
    except OcrSetupError:
        raise HTTPException(status_code=503, detail="Image check is not configured") from None
    checked: list[ImageCheckResult] = []
    for file in files:
        try:
            result = reader.read(str(file.uri))
        except OcrUnavailableError:
            raise HTTPException(status_code=503, detail="Image check temporarily unavailable") from None
        except OcrSetupError:
            raise HTTPException(status_code=503, detail="Image check is not configured") from None
        except OcrError:
            checked.append(ImageCheckResult(name=file.name, verdict="not_allowed"))
            continue
        checked.append(ImageCheckResult(name=file.name, verdict=verdict_from_read(result)))
    return checked


@router.post("/images/check", response_model=dict[str, list[ImageCheckResult]])
def check_images(
    body: ImageCheckRequest,
    authorization: Annotated[str | None, Header()] = None,
) -> dict[str, list[ImageCheckResult]]:
    _authorize(authorization)
    return {"data": _check(body.files, lambda: Ocr(docint()))}
