"""ai_jobs 처리기 실행: python -m app.worker

API 서버(uvicorn)와 따로 띄웁니다.
  - 사용자가 기다리는 작업과 미리 해 두는 작업(handlers.BACKGROUND)을 따로 도는 반복이
    처리합니다. 미리 만들기를 처리하는 중에도 사용자 작업이 바로 시작됩니다(#138).
  - 사용자 작업 반복은 AI_JOB_USER_LANES개입니다(#521). 여러 사람의 작업이 앞 작업을 기다리지
    않게, 늘린 반복은 가벼운 작업을 함께 처리합니다. 노트 · 녹음 정리(handlers.HEAVY)는 메모리를
    많이 써서 첫 반복만 가져갑니다(동시에 하나).
  - 여러 개를 띄워도 같은 작업을 함께 가져가지 않습니다. 다만 LLM의 분당 한도는 프로세스마다
    따로 지키므로(LLM_CALL_GAP_SEC), 처리기는 하나만 띄우고 반복 수로 늘립니다.
  - SIGINT · SIGTERM을 받으면 처리 중인 작업을 끝낸 뒤 멈춥니다. 한 번 더 받으면 바로 끝납니다
    (그 작업은 잠금이 끝난 뒤 다시 처리됨). 배포 환경의 종료 대기 시간이 짧으면 작업 중간에
    끝날 수 있으니, 대기 시간을 길게 두거나 다시 처리되는 것을 감안합니다.
"""

import logging
import os
import signal
import socket
import threading
from collections.abc import Callable

from pymongo import MongoClient

from app.clients.llm import JsonObject, llm_setup_problem
from app.core.config import settings
from app.services.quiz.generate import PREGEN_TYPE
from app.worker.handlers import BACKGROUND, HANDLERS, HEAVY, use_spend
from app.worker.jobs import JobStore, use_spool
from app.worker.runner import Lane, run_lanes

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


def make_lanes(store: Callable[[str], JobStore], user_lanes: int) -> list[Lane]:
    """미리 만들기 반복 하나와 사용자 작업 반복 user_lanes개(#521).

    store(접미사)는 반복마다 따로 만든 JobStore(잠금 주인 이름 = 처리기 + 접미사). 첫 사용자
    반복은 모든 종류, 늘린 반복은 무거운 종류(HEAVY)를 뺀 나머지를 가져갑니다. 반복이 둘 이상이면
    첫 반복은 무거운 종류를 먼저 가져갑니다: 가벼운 작업은 늘린 반복이 받으므로, 노트 · 녹음
    정리가 먼저 들어온 가벼운 작업 뒤에서 기다리지 않게.
    """
    light = {t: h for t, h in HANDLERS.items() if t not in HEAVY}
    return [
        # 미리 만들기를 먼저: 퀴즈마다 생기는 개념 카드 작업(#558)이 쌓여도 새 노트의 미리 만들기가
        # 그 뒤에서 기다리지 않게(카드는 덤)
        Lane(
            "background",
            store(":bg"),
            {t: h for t, h in HANDLERS.items() if t in BACKGROUND},
            first=frozenset({PREGEN_TYPE}),
        ),
        # 사용자가 이어받은(awaited) 미리 만들기도 가져감: 다른 미리 만들기 뒤에서 기다리지 않게
        Lane(
            "user",
            store(""),
            HANDLERS,
            awaited_only=BACKGROUND,
            first=HEAVY if user_lanes > 1 else frozenset(),
        ),
        *(
            Lane(f"user-{i}", store(f":u{i}"), light, awaited_only=BACKGROUND)
            for i in range(2, user_lanes + 1)
        ),
    ]


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    uri = settings.mongodb_uri.get_secret_value()
    if not uri:
        raise SystemExit("MONGODB_URI가 비어 있습니다(.env.production 참고)")
    if not HANDLERS:
        log.warning("등록된 작업 종류가 없습니다. 6~8번 PR에서 app/worker/handlers.py에 추가합니다")
    elif problem := llm_setup_problem():
        # 설정이 틀리면 작업마다 실패하므로 시작할 때 막음
        raise SystemExit(f"LLM 설정 오류: {problem} (.env.production 참고)")
    client: MongoClient[JsonObject] = MongoClient(uri, tz_aware=True)
    worker = f"{socket.gethostname()}:{os.getpid()}"

    def store(suffix: str) -> JobStore:
        # 반복마다 따로: 멈춘 작업 정리(SWEEP_EVERY)가 반복마다 자기 종류를 보게
        return JobStore(
            client[settings.mongodb_db]["ai_jobs"],
            worker + suffix,
            lock_sec=settings.ai_job_lock_sec,
            max_attempts=settings.ai_job_max_attempts,
            retry_delay_sec=settings.ai_job_retry_delay_sec,
        )

    uses_claude = "claude" in (settings.llm_provider, settings.split_provider)
    if uses_claude and settings.claude_budget_usd > 0:
        if left := use_spool(settings.llm_cost_spool, client[settings.mongodb_db]["ai_jobs"]):
            log.warning("지난번에 DB에 적지 못한 Claude 비용 %d건을 다시 적습니다", left)
        spend = use_spend(store(":spend").claude_spent)
        log.info(  # 못 읽으면 inf(그동안 학교 LLM, 곧 다시 읽음)
            "Claude 비용: 지금까지 %.2f달러 / 한도 %.2f달러(닿으면 학교 LLM으로)",
            spend.total(),
            settings.claude_budget_usd,
        )
        if not settings.school_llm_base_url:
            log.warning(
                "SCHOOL_LLM_BASE_URL이 비어 있음: Claude 한도에 닿으면 작업이 설정 오류로 끝남"
            )
    lanes = make_lanes(store, settings.ai_job_user_lanes)
    stop = threading.Event()
    stop_on_signal(stop)
    for lane in lanes:
        log.info("ai_jobs 처리 반복 %s: %s", lane.name, ", ".join(lane.handlers) or "-")
    try:
        run_lanes(lanes, poll_sec=settings.ai_job_poll_sec, stop=stop)
    finally:
        client.close()


if __name__ == "__main__":
    main()
