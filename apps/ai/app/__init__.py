from app.core import http_log

# httpx2 요청 로그에 주소의 SAS가 남지 않게, app의 어느 모듈을 불러도 먼저 붙임(#277)
http_log.install()
