from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# backend/app/config.py -> backend/
_BACKEND_DIR = Path(__file__).resolve().parent.parent
# backend/ -> repo root (e.g. .../apps)
_REPO_ROOT = _BACKEND_DIR.parent

# Load both if present: root first, then backend (backend wins on duplicate keys)
_env_candidates = [_REPO_ROOT / ".env", _BACKEND_DIR / ".env"]
_env_files = tuple(str(p) for p in _env_candidates if p.is_file())

_model_config: dict = {"env_file_encoding": "utf-8", "extra": "ignore"}
if _env_files:
    _model_config["env_file"] = _env_files


class Settings(BaseSettings):
    model_config = SettingsConfigDict(**_model_config)

    DATABASE_URL: str = "sqlite:///./data/app.db"
    ADMIN_TOKEN: str = "change-me-in-production"

    DIGEST_TIMEZONE: str = "Asia/Shanghai"
    DIGEST_OFFSET_DAYS: int = 1

    ARXIV_QUERY_BASE: str = ""
    ARXIV_MAX_FETCH: int = 800

    WECHAT_APP_ID: str = ""
    WECHAT_APP_SECRET: str = ""
    WECHAT_TEMPLATE_ID: str = ""


settings = Settings()
