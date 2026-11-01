"""Azure Document Intelligence(OCR) · Blob 클라이언트. 사진은 Blob 읽기 전용 주소로 OCR에 넘김."""

from datetime import UTC, datetime, timedelta
from typing import Any, Literal

from azure.ai.documentintelligence import DocumentIntelligenceClient
from azure.ai.documentintelligence.models import AnalyzeDocumentRequest
from azure.core.credentials import AzureKeyCredential
from azure.storage.blob import BlobSasPermissions, BlobServiceClient, generate_blob_sas

from app.core.config import settings

type OcrModel = Literal["prebuilt-read", "prebuilt-layout"]

SAS_MINUTES = 15


def read_url(
    blobs: BlobServiceClient, container: str, name: str, minutes: int = SAS_MINUTES
) -> str:
    """Blob 하나의 읽기 전용 주소(SAS)."""
    key = blobs.credential.account_key
    sas = generate_blob_sas(
        account_name=blobs.account_name or "",
        container_name=container,
        blob_name=name,
        account_key=key,
        permission=BlobSasPermissions(read=True),
        expiry=datetime.now(UTC) + timedelta(minutes=minutes),
    )
    # 이름의 # · 공백 등은 SDK가 인코딩한 주소를 씀
    return f"{blobs.get_blob_client(container, name).url}?{sas}"


def ocr(
    client: DocumentIntelligenceClient, url: str, model: OcrModel = "prebuilt-read"
) -> dict[str, Any]:
    """사진 · PDF 주소 → OCR 결과(dict). layout.lines_from_read에 그대로 넣습니다."""
    poller = client.begin_analyze_document(model, AnalyzeDocumentRequest(url_source=url))
    result: dict[str, Any] = poller.result().as_dict()
    return result


def docint() -> DocumentIntelligenceClient:
    return DocumentIntelligenceClient(
        settings.azure_docint_endpoint,
        AzureKeyCredential(settings.azure_docint_key.get_secret_value()),
    )


def blob_service() -> BlobServiceClient:
    return BlobServiceClient.from_connection_string(
        settings.azure_storage_connection_string.get_secret_value()
    )
