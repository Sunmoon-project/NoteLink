from typing import Literal, Self

from pydantic import SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# LLM_PROVIDER마다 모델 · 호출 간격의 기본값. 환경 변수로 넣은 값이 있으면 그 값을 씁니다(#278)
LLM_DEFAULTS: dict[str, dict[str, str]] = {
    "claude": {
        "quiz_gen_model": "claude-sonnet-5-5",
        "quiz_check_model": "claude-haiku-5-5",
        "note_split_model": "claude-sonnet-5-5",
        "note_refine_model": "claude-sonnet-5-5",
        "recording_model": "claude-sonnet-5-5",
    },
    "school": {
        "quiz_gen_model": "gemma-4-26b",
        "quiz_check_model": "qwen-27b",
        "note_split_model": "gemma-4-26b",
        "note_refine_model": "gemma-4-26b",  # qwen은 호출 1~3분이라 쓰지 않음(10/30 실험)
        "recording_model": "gemma-4-26b",
    },
}
# 보내는 간격(초). 학교 LLM은 분당 30회 한도 아래로. Claude는 분당 50회(가장 낮은 등급)
# 아래로 잡아 둠: 워크스페이스 한도를 확인하면 LLM_CALL_GAP_SEC로 줄임
GAP_DEFAULTS = {"claude": 1.2, "school": 2.2}


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_env: str = "development"

    # 퀴즈 · 노트 · 녹음이 쓰는 LLM. claude(기본, #278) · school(학교 LLM, OpenAI 호환)
    llm_provider: Literal["claude", "school"] = "claude"
    anthropic_api_key: SecretStr = SecretStr("")
    llm_effort: Literal["low", "medium", "high"] = "low"  # Claude output_config.effort
    school_llm_base_url: str = ""
    school_llm_api_key: SecretStr = SecretStr("")
    # 모델 · 간격은 비워 두면 LLM_DEFAULTS · GAP_DEFAULTS에서 LLM_PROVIDER에 맞춰 채움
    quiz_gen_model: str = ""  # 문제 만들기
    quiz_check_model: str = ""  # 만든 문제를 직접 풀어 보는 검사
    llm_call_gap_sec: float | None = None
    note_split_model: str = ""  # 노트 문단 경계 고르기 (글자는 고치지 않음)
    # 노트 후처리(오타 고치기 · 개념 태그). 과목 용어 사전이 준비될 때까지 꺼 둠
    note_refine_enabled: bool = False
    note_refine_model: str = ""

    # ai_jobs 작업 처리기. FastAPI는 이 컬렉션만 읽고 씁니다(DB · 색인 관리는 NestJS).
    mongodb_uri: SecretStr = SecretStr("")
    mongodb_db: str = "notelink"
    ai_job_lock_sec: int = 900  # 잠금 시간. 진행률을 쓸 때마다 다시 늘어남
    ai_job_max_attempts: int = 3  # 일시 오류(LLM 응답 실패 · 처리기 멈춤) 포함 최대 시도
    ai_job_retry_delay_sec: int = 30  # 다시 시도까지 기다리는 시간 × 시도 횟수
    ai_job_poll_sec: float = 2.0  # 할 일이 없을 때 다시 볼 간격

    # 노트 쪽: OCR(Azure Document Intelligence) · 파일(Blob) · 임베딩(Voyage). 키는 .env에만.
    azure_docint_endpoint: str = ""
    azure_docint_key: SecretStr = SecretStr("")
    azure_storage_connection_string: SecretStr = SecretStr("")
    voyage_base_url: str = "https://api.voyageai.com/v1"
    voyage_api_key: SecretStr = SecretStr("")
    voyage_model: str = "voyage-4"  # 1,024차원

    # 녹음 쪽: 음성 인식(Azure AI Speech). 키는 .env에만.
    azure_speech_endpoint: str = ""
    azure_speech_key: SecretStr = SecretStr("")
    recording_model: str = ""  # 녹음 슬라이드 만들기 (경계 · 제목 · 요약 · 도식)
    # 2시간 녹음: LLM 약 39번 × (간격 2.2초 + 응답 약 75초) ≈ 50분 + STT 약 10분
    recording_job_max_sec: int = 3600

    @model_validator(mode="after")
    def _fill_llm_defaults(self) -> Self:
        for field, model in LLM_DEFAULTS[self.llm_provider].items():
            if not getattr(self, field):
                setattr(self, field, model)
        return self

    @property
    def call_gap_sec(self) -> float:
        """LLM 호출 간격. LLM_CALL_GAP_SEC가 없으면 제공자 기본값."""
        if self.llm_call_gap_sec is not None:
            return self.llm_call_gap_sec
        return GAP_DEFAULTS[self.llm_provider]

    @property
    def is_production(self) -> bool:
        return self.app_env == "production"


settings = Settings()
