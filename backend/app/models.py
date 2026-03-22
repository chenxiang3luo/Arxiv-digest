from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    Table,
    Column,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


feishu_target_keywords = Table(
    "feishu_target_keywords",
    Base.metadata,
    Column("feishu_target_id", ForeignKey("feishu_targets.id", ondelete="CASCADE"), primary_key=True),
    Column("keyword_id", ForeignKey("keywords.id", ondelete="CASCADE"), primary_key=True),
)

wechat_subscriber_keywords = Table(
    "wechat_subscriber_keywords",
    Base.metadata,
    Column("wechat_subscriber_id", ForeignKey("wechat_subscribers.id", ondelete="CASCADE"), primary_key=True),
    Column("keyword_id", ForeignKey("keywords.id", ondelete="CASCADE"), primary_key=True),
)


class Keyword(Base):
    __tablename__ = "keywords"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    phrase: Mapped[str] = mapped_column(String(512), unique=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class FeishuTarget(Base):
    __tablename__ = "feishu_targets"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(256), nullable=False)
    webhook_url: Mapped[str] = mapped_column(String(2048), nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    keywords: Mapped[list["Keyword"]] = relationship(
        secondary=feishu_target_keywords,
        lazy="selectin",
    )
    profile: Mapped["FeishuTargetProfile | None"] = relationship(
        back_populates="target",
        uselist=False,
        cascade="all, delete-orphan",
        lazy="selectin",
    )


class FeishuTargetProfile(Base):
    __tablename__ = "feishu_target_profiles"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    feishu_target_id: Mapped[int] = mapped_column(
        ForeignKey("feishu_targets.id", ondelete="CASCADE"),
        unique=True,
        nullable=False,
    )
    user_label: Mapped[str] = mapped_column(String(256), default="")
    preview_start_date: Mapped[str] = mapped_column(String(10), default="")
    preview_end_date: Mapped[str] = mapped_column(String(10), default="")

    target: Mapped["FeishuTarget"] = relationship(back_populates="profile")


class WeChatSettings(Base):
    __tablename__ = "wechat_settings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    app_id: Mapped[str] = mapped_column(String(64), default="")
    app_secret: Mapped[str] = mapped_column(String(256), default="")
    template_id: Mapped[str] = mapped_column(String(128), default="")
    field_mapping: Mapped[str] = mapped_column(
        Text,
        default='{"digest_title":"thing1","digest_body":"thing2","link":"url"}',
    )
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class WeChatSubscriber(Base):
    __tablename__ = "wechat_subscribers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    openid: Mapped[str] = mapped_column(String(128), unique=True, nullable=False)
    label: Mapped[str] = mapped_column(String(256), default="")
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    keywords: Mapped[list["Keyword"]] = relationship(
        secondary=wechat_subscriber_keywords,
        lazy="selectin",
    )


class DigestRun(Base):
    __tablename__ = "digest_runs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    digest_date: Mapped[str] = mapped_column(String(10), nullable=False)
    recipient_type: Mapped[str] = mapped_column(String(16), nullable=False)  # feishu | wechat
    recipient_id: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False)
    paper_count: Mapped[int] = mapped_column(Integer, default=0)
    error_message: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    __table_args__ = (UniqueConstraint("digest_date", "recipient_type", "recipient_id", name="uq_digest_recipient"),)
