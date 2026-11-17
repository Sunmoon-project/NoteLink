"""httpx2 요청 로그에서 주소의 쿼리를 가립니다.

httpx2는 요청마다 INFO로 'HTTP Request: GET <전체 주소> ...'를 남기는데, 사진 내려받기
(docint.download)처럼 주소의 쿼리에 Blob 읽기 권한(SAS)이 담긴 요청도 있습니다. 처리기는
INFO로 로그를 켜므로(worker.__main__) 그대로 두면 SAS가 로그에 남습니다(Codex 리뷰 #277).
레벨을 올려 요청 로그를 통째로 끄지 않고 쿼리만 가려, 어느 주소 · 상태로 불렀는지는 남깁니다.

app 패키지를 불러올 때 붙이므로(app/__init__.py) 처리기 · API 서버 · 테스트 모두에 적용되고,
httpx2를 쓰는 모든 클라이언트(LLM · 음성 · 임베딩 · 내려받기)에 함께 적용됩니다.
"""

import logging
from urllib.parse import urlsplit, urlunsplit

import httpx2

HTTP_LOGGER = "httpx2"
HIDDEN = "REDACTED"


def hide_query(url: str) -> str:
    """http(s) 주소의 쿼리 · 조각을 HIDDEN으로 바꿈. 주소가 아니면 그대로."""
    try:
        parts = urlsplit(url)
    except ValueError:
        return url
    if parts.scheme not in ("http", "https") or not (parts.query or parts.fragment):
        return url
    return urlunsplit(parts._replace(query=HIDDEN, fragment=""))


def _hide(arg: object) -> object:
    if isinstance(arg, httpx2.URL):
        return hide_query(str(arg))
    if isinstance(arg, str):
        return hide_query(arg)
    return arg


class HideQueryFilter(logging.Filter):
    """로그 인자 중 주소(httpx2.URL · http(s) 문자열)의 쿼리를 가림. 기록은 막지 않음."""

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.args, tuple):
            record.args = tuple(_hide(a) for a in record.args)
        return True


_FILTER = HideQueryFilter()


def install() -> None:
    """httpx2 로거에 필터를 붙임. 여러 번 불러도 하나만 붙음."""
    logging.getLogger(HTTP_LOGGER).addFilter(_FILTER)
