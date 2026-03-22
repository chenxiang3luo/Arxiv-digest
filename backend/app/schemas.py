from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field


class KeywordCreate(BaseModel):
    phrase: str = Field(..., min_length=1, max_length=512)


class KeywordOut(BaseModel):
    id: int
    phrase: str
    created_at: datetime

    model_config = {"from_attributes": True}


class FeishuTargetCreate(BaseModel):
    name: str = Field(..., max_length=256)
    target_user_label: str = Field("", max_length=256)
    target_preview_start_date: str = Field("", max_length=10)
    target_preview_end_date: str = Field("", max_length=10)
    webhook_url: str = Field(..., max_length=2048)
    enabled: bool = True
    keyword_ids: list[int] = []


class FeishuTargetUpdate(BaseModel):
    name: Optional[str] = Field(None, max_length=256)
    target_user_label: Optional[str] = Field(None, max_length=256)
    target_preview_start_date: Optional[str] = Field(None, max_length=10)
    target_preview_end_date: Optional[str] = Field(None, max_length=10)
    webhook_url: Optional[str] = Field(None, max_length=2048)
    enabled: Optional[bool] = None
    keyword_ids: Optional[list[int]] = None


class FeishuTargetOut(BaseModel):
    id: int
    name: str
    target_user_label: str
    target_preview_start_date: str
    target_preview_end_date: str
    webhook_url: str
    enabled: bool
    keyword_ids: list[int]
    created_at: datetime

    model_config = {"from_attributes": True}


class FeishuPreviewDigestBody(BaseModel):
    start_date: Optional[str] = None
    end_date: Optional[str] = None


class WeChatSettingsOut(BaseModel):
    app_id: str
    template_id: str
    field_mapping: str
    has_app_secret: bool
    updated_at: datetime

    model_config = {"from_attributes": True}


class WeChatSettingsUpdate(BaseModel):
    app_id: Optional[str] = Field(None, max_length=64)
    app_secret: Optional[str] = Field(None, max_length=256)
    template_id: Optional[str] = Field(None, max_length=128)
    field_mapping: Optional[str] = None


class WeChatSubscriberCreate(BaseModel):
    openid: str = Field(..., max_length=128)
    label: str = Field("", max_length=256)
    enabled: bool = True
    keyword_ids: list[int] = []


class WeChatSubscriberUpdate(BaseModel):
    label: Optional[str] = Field(None, max_length=256)
    enabled: Optional[bool] = None
    keyword_ids: Optional[list[int]] = None


class WeChatSubscriberOut(BaseModel):
    id: int
    openid: str
    label: str
    enabled: bool
    keyword_ids: list[int]
    created_at: datetime

    model_config = {"from_attributes": True}


class DigestRunBody(BaseModel):
    force: bool = False
    dry_run: bool = False


class DigestRunResult(BaseModel):
    digest_date: str
    results: list[dict]
