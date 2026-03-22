import os

from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker, DeclarativeBase

from app.config import settings


class Base(DeclarativeBase):
    pass


connect_args = {}
if settings.DATABASE_URL.startswith("sqlite"):
    connect_args["check_same_thread"] = False
    raw = settings.DATABASE_URL.replace("sqlite:///", "", 1)
    if raw and not raw.startswith(":memory:"):
        dirpath = os.path.dirname(os.path.abspath(raw))
        if dirpath:
            os.makedirs(dirpath, exist_ok=True)

engine = create_engine(settings.DATABASE_URL, connect_args=connect_args)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db():
    from app import models  # noqa: F401

    Base.metadata.create_all(bind=engine)
    _ensure_compat_columns()


def _ensure_compat_columns() -> None:
    if not settings.DATABASE_URL.startswith("sqlite"):
        return
    with engine.begin() as conn:
        rows = conn.execute(text("PRAGMA table_info(feishu_target_profiles)")).mappings().all()
        if not rows:
            return
        columns = {r["name"] for r in rows}
        if "preview_start_date" not in columns:
            conn.execute(text("ALTER TABLE feishu_target_profiles ADD COLUMN preview_start_date VARCHAR(10) DEFAULT ''"))
        if "preview_end_date" not in columns:
            conn.execute(text("ALTER TABLE feishu_target_profiles ADD COLUMN preview_end_date VARCHAR(10) DEFAULT ''"))
