"""ai_jobs 처리기 실행: python -m app.worker

API 서버(uvicorn)와 따로 띄웁니다.
  - 여러 개를 띄워도 같은 작업을 함께 가져가지 않습니다. 다만 학교 LLM의 분당 한도는
    프로세스마다 따로 지키므로(llm_call_gap_sec), 학교 LLM을 쓰는 동안에는 하나만 띄웁니다.
  - SIGINT · SIGTERM을 받으면 처리 중인 작업을 끝낸 뒤 멈춥니다. 한 번 더 받으면 바로 끝납니다
    (그 작업은 잠금이 끝난 뒤 다시 처리됨). 배포 환경의 종료 대기 시간이 짧으면 작업 중간에
    끝날 수 있으니, 대기 시간을 길게 두거나 다시 처리되는 것을 감안합니다.
"""

import logging
import os
import signal
import socket
import threading

from pymongo import MongoClient

from app.clients.llm import JsonObject
from app.core.config import settings
from app.worker.handlers import HANDLERS
from app.worker.jobs import JobStore
from app.worker.runner import run_forever

log = logging.getLogger("app.worker")


STOP_SIGNALS = (signal.SIGINT, signal.SIGTERM)


def stop_on_signal(stop: threading.Event) -> None:
    """첫 멈춤 신호는 stop을 켜고(지금 작업을 끝낸 뒤 멈춤), 다음 신호는 기본 처리(바로 끝남)."""

    def on_signal(signum: int, frame: object) -> None:
        log.info("멈춤 신호: 처리 중인 작업을 끝낸 뒤 멈춥니다(한 번 더 보내면 바로 끝남)")
        stop.set()
        for sig in STOP_SIGNALS:
            signal.signal(sig, signal.SIG_DFL)

    for sig in STOP_SIGNALS:
        signal.signal(sig, on_signal)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    uri = settings.mongodb_uri.get_secret_value()
    if not uri:
        raise SystemExit("MONGODB_URI가 비어 있습니다(.env.example 참고)")
    if not HANDLERS:
        log.warning("등록된 작업 종류가 없습니다. 6~8번 PR에서 app/worker/handlers.py에 추가합니다")
    elif not settings.school_llm_base_url:
        # 설정이 없으면 작업마다 다시 시도를 거쳐 실패하므로 시작할 때 막음
        raise SystemExit("SCHOOL_LLM_BASE_URL이 비어 있습니다(.env.example 참고)")
    client: MongoClient[JsonObject] = MongoClient(uri, tz_aware=True)
    store = JobStore(
        client[settings.mongodb_db]["ai_jobs"],
        f"{socket.gethostname()}:{os.getpid()}",
        lock_sec=settings.ai_job_lock_sec,
        max_attempts=settings.ai_job_max_attempts,
        retry_delay_sec=settings.ai_job_retry_delay_sec,
    )
    stop = threading.Event()
    stop_on_signal(stop)
    log.info("ai_jobs 처리기 시작: %s", ", ".join(HANDLERS) or "-")
    try:
        run_forever(store, HANDLERS, poll_sec=settings.ai_job_poll_sec, stop=stop)
    finally:
        client.close()


if __name__ == "__main__":
    main()
