from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_env: str = "development"

    # 학교 LLM(OpenAI 호환). Claude 키를 받기 전까지 퀴즈 · 에이전트는 이 서버를 씁니다(10/21).
    school_llm_base_url: str = ""
    school_llm_api_key: SecretStr = SecretStr("")
    quiz_gen_model: str = "gemma-4-26b"  # 문제 만들기
    quiz_check_model: str = "qwen-27b"  # 만든 문제를 직접 풀어 보는 검사
    llm_call_gap_sec: float = 2.2  # 분당 30회 한도 아래로 유지
    note_split_model: str = "gemma-4-26b"  # 노트 문단 경계 고르기 (글자는 고치지 않음)

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

    @property
    def is_production(self) -> bool:
        return self.app_env == "production"


settings = Settings()
