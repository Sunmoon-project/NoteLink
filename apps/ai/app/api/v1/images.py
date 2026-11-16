"""NestJS 내부에서 호출하는 학습자료 이미지 사전 검사."""

from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from secrets import compare_digest
from typing import Annotated

from fastapi import APIRouter, Header, HTTPException
from pydantic import AnyHttpUrl, BaseModel, Field, StringConstraints

from app.clients.docint import Ocr, OcrError, OcrSetupError, OcrUnavailableError, docint
from app.core.config import settings
from app.services.image_check import ImageVerdict, verdict_from_read

router = APIRouter()
MAX_FILES = 20
# 파일마다 OCR 호출이 몇 초씩 걸려, 순차로 읽으면 20장이 NestJS의 90초 제한(images.service.ts)에
# 걸릴 수 있다. 동시에 읽는 수는 Document Intelligence 호출 한도를 넘지 않게 낮게 둔다.
MAX_WORKERS = 4


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
    if (
        not authorization
        or not authorization.startswith("Bearer ")
        or not compare_digest(supplied, expected)
    ):
        raise HTTPException(status_code=401, detail="Unauthorized")


def _check_one(reader: Ocr, file: ImageCheckFile) -> ImageCheckResult:
    try:
        result = reader.read(str(file.uri))
    except OcrUnavailableError:
        raise HTTPException(status_code=503, detail="Image check temporarily unavailable") from None
    except OcrSetupError:
        raise HTTPException(status_code=503, detail="Image check is not configured") from None
    except OcrError:
        return ImageCheckResult(name=file.name, verdict="not_allowed")
    return ImageCheckResult(name=file.name, verdict=verdict_from_read(result))


def _check(files: list[ImageCheckFile], make_ocr: Callable[[], Ocr]) -> list[ImageCheckResult]:
    try:
        reader = make_ocr()
    except OcrSetupError:
        raise HTTPException(status_code=503, detail="Image check is not configured") from None
    # 결과는 요청한 파일 순서를 지키고, 실패는 파일 순서상 처음 실패한 것이 올라온다.
    with ThreadPoolExecutor(max_workers=min(MAX_WORKERS, len(files))) as pool:
        futures = [pool.submit(_check_one, reader, file) for file in files]
        try:
            return [future.result() for future in futures]
        except BaseException:
            for future in futures:
                future.cancel()  # 아직 시작하지 않은 파일은 읽지 않는다
            raise


@router.post("/images/check", response_model=dict[str, list[ImageCheckResult]])
def check_images(
    body: ImageCheckRequest,
    authorization: Annotated[str | None, Header()] = None,
) -> dict[str, list[ImageCheckResult]]:
    _authorize(authorization)
    return {"data": _check(body.files, lambda: Ocr(docint()))}
