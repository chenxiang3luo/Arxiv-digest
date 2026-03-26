import logging
from contextlib import asynccontextmanager
from datetime import date
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import verify_admin
from app.config import settings
from app.database import get_db, init_db
from app.models import FeishuTarget, FeishuTargetProfile, Keyword, WeChatSettings, WeChatSubscriber
from app.schemas import (
    DigestRunBody,
    DigestRunResult,
    FeishuPreviewDigestBody,
    FeishuTargetCreate,
    FeishuTargetOut,
    FeishuTargetUpdate,
    KeywordCreate,
    KeywordOut,
    WeChatSettingsOut,
    WeChatSettingsUpdate,
    WeChatSubscriberCreate,
    WeChatSubscriberOut,
    WeChatSubscriberUpdate,
)
from app.services import digest_runner, feishu, wechat
from app.services.arxiv_service import (
    digest_calendar_date,
    filter_by_keywords,
    format_paper_line,
    papers_for_digest,
    papers_for_date_range,
)
from app.models import feishu_target_keywords, wechat_subscriber_keywords
from sqlalchemy import delete, insert

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    if settings.ADMIN_TOKEN == "change-me-in-production":
        logger.warning(
            "ADMIN_TOKEN is still the default. Set ADMIN_TOKEN in .env (repo root or backend/) and restart."
        )
    yield


app = FastAPI(title="arXiv digest", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _ensure_wechat_settings(db: Session) -> WeChatSettings:
    row = db.scalars(select(WeChatSettings).limit(1)).first()
    if row is None:
        row = WeChatSettings()
        db.add(row)
        db.commit()
        db.refresh(row)
    return row


def _feishu_out(t: FeishuTarget) -> FeishuTargetOut:
    return FeishuTargetOut(
        id=t.id,
        name=t.name,
        target_user_label=(t.profile.user_label if t.profile else ""),
        target_preview_start_date=(t.profile.preview_start_date if t.profile else ""),
        target_preview_end_date=(t.profile.preview_end_date if t.profile else ""),
        webhook_url=t.webhook_url,
        enabled=t.enabled,
        keyword_ids=[k.id for k in t.keywords],
        created_at=t.created_at,
    )


def _wechat_sub_out(s: WeChatSubscriber) -> WeChatSubscriberOut:
    return WeChatSubscriberOut(
        id=s.id,
        openid=s.openid,
        label=s.label,
        enabled=s.enabled,
        keyword_ids=[k.id for k in s.keywords],
        created_at=s.created_at,
    )


def _feishu_keyword_phrases(db: Session, target: FeishuTarget) -> list[str]:
    return [k.phrase for k in target.keywords]


def _parse_date_range(body: FeishuPreviewDigestBody) -> tuple[date, date]:
    if not body.start_date and not body.end_date:
        d = digest_calendar_date()
        return d, d
    if not body.start_date or not body.end_date:
        raise HTTPException(400, "start_date and end_date must be provided together")
    try:
        start = date.fromisoformat(body.start_date)
        end = date.fromisoformat(body.end_date)
    except ValueError:
        raise HTTPException(400, "start_date and end_date must be YYYY-MM-DD")
    if end < start:
        raise HTTPException(400, "end_date must be >= start_date")
    if (end - start).days + 1 > 14:
        raise HTTPException(400, "date range too large (max 14 days)")
    return start, end


def _normalize_preview_range(start_raw: str, end_raw: str) -> tuple[str, str]:
    start_s = (start_raw or "").strip()
    end_s = (end_raw or "").strip()
    if not start_s and not end_s:
        return "", ""
    if not start_s or not end_s:
        raise HTTPException(400, "target_preview_start_date and target_preview_end_date must be provided together")
    try:
        start = date.fromisoformat(start_s)
        end = date.fromisoformat(end_s)
    except ValueError:
        raise HTTPException(400, "target preview dates must be YYYY-MM-DD")
    if end < start:
        raise HTTPException(400, "target preview end date must be >= start date")
    if (end - start).days + 1 > 14:
        raise HTTPException(400, "target preview date range too large (max 14 days)")
    return start.isoformat(), end.isoformat()


def _resolve_preview_range(body: FeishuPreviewDigestBody, t: FeishuTarget) -> tuple[date, date]:
    if body.start_date or body.end_date:
        return _parse_date_range(body)
    if t.profile and t.profile.preview_start_date and t.profile.preview_end_date:
        return _parse_date_range(
            FeishuPreviewDigestBody(
                start_date=t.profile.preview_start_date,
                end_date=t.profile.preview_end_date,
            )
        )
    d = digest_calendar_date()
    return d, d


@app.get("/health")
def health():
    return {"ok": True}


# --- Keywords ---
@app.get("/api/keywords", response_model=list[KeywordOut])
def list_keywords(db: Session = Depends(get_db), _: None = Depends(verify_admin)):
    return db.scalars(select(Keyword).order_by(Keyword.id)).all()


@app.post("/api/keywords", response_model=KeywordOut)
def create_keyword(
    body: KeywordCreate,
    db: Session = Depends(get_db),
    _: None = Depends(verify_admin),
):
    phrase = body.phrase.strip()
    if not phrase:
        raise HTTPException(400, "empty phrase")
    existing = db.scalars(select(Keyword).where(Keyword.phrase == phrase)).first()
    if existing:
        raise HTTPException(409, "keyword exists")
    k = Keyword(phrase=phrase)
    db.add(k)
    db.commit()
    db.refresh(k)
    return k


@app.delete("/api/keywords/{kid}")
def delete_keyword(kid: int, db: Session = Depends(get_db), _: None = Depends(verify_admin)):
    k = db.get(Keyword, kid)
    if not k:
        raise HTTPException(404)
    db.delete(k)
    db.commit()
    return {"deleted": True}


# --- Feishu targets ---
@app.get("/api/feishu-targets", response_model=list[FeishuTargetOut])
def list_feishu(db: Session = Depends(get_db), _: None = Depends(verify_admin)):
    rows = db.scalars(select(FeishuTarget).order_by(FeishuTarget.id)).all()
    return [_feishu_out(t) for t in rows]


@app.post("/api/feishu-targets", response_model=FeishuTargetOut)
def create_feishu(
    body: FeishuTargetCreate,
    db: Session = Depends(get_db),
    _: None = Depends(verify_admin),
):
    if not body.webhook_url.startswith("https://"):
        raise HTTPException(400, "webhook must be https")
    t = FeishuTarget(name=body.name.strip(), webhook_url=body.webhook_url, enabled=body.enabled)
    db.add(t)
    db.commit()
    db.refresh(t)
    preview_start, preview_end = _normalize_preview_range(
        body.target_preview_start_date,
        body.target_preview_end_date,
    )
    if body.target_user_label.strip() or preview_start or preview_end:
        db.add(
            FeishuTargetProfile(
                feishu_target_id=t.id,
                user_label=body.target_user_label.strip(),
                preview_start_date=preview_start,
                preview_end_date=preview_end,
            )
        )
        db.commit()
        db.refresh(t)
    if body.keyword_ids:
        for kid in body.keyword_ids:
            if db.get(Keyword, kid):
                db.execute(insert(feishu_target_keywords).values(feishu_target_id=t.id, keyword_id=kid))
        db.commit()
    db.refresh(t)
    return _feishu_out(t)


@app.patch("/api/feishu-targets/{tid}", response_model=FeishuTargetOut)
def update_feishu(
    tid: int,
    body: FeishuTargetUpdate,
    db: Session = Depends(get_db),
    _: None = Depends(verify_admin),
):
    t = db.get(FeishuTarget, tid)
    if not t:
        raise HTTPException(404)
    if body.name is not None:
        t.name = body.name.strip()
    if body.webhook_url is not None:
        if not body.webhook_url.startswith("https://"):
            raise HTTPException(400, "webhook must be https")
        t.webhook_url = body.webhook_url
    if body.enabled is not None:
        t.enabled = body.enabled
    if body.target_user_label is not None:
        p = db.scalars(select(FeishuTargetProfile).where(FeishuTargetProfile.feishu_target_id == tid)).first()
        value = body.target_user_label.strip()
        if p is None:
            if value:
                db.add(FeishuTargetProfile(feishu_target_id=tid, user_label=value))
        else:
            p.user_label = value
    if body.target_preview_start_date is not None or body.target_preview_end_date is not None:
        p = db.scalars(select(FeishuTargetProfile).where(FeishuTargetProfile.feishu_target_id == tid)).first()
        curr_start = p.preview_start_date if p else ""
        curr_end = p.preview_end_date if p else ""
        next_start_raw = curr_start if body.target_preview_start_date is None else body.target_preview_start_date
        next_end_raw = curr_end if body.target_preview_end_date is None else body.target_preview_end_date
        next_start, next_end = _normalize_preview_range(next_start_raw, next_end_raw)
        if p is None:
            db.add(
                FeishuTargetProfile(
                    feishu_target_id=tid,
                    user_label="",
                    preview_start_date=next_start,
                    preview_end_date=next_end,
                )
            )
        else:
            p.preview_start_date = next_start
            p.preview_end_date = next_end
    db.commit()
    if body.keyword_ids is not None:
        db.execute(delete(feishu_target_keywords).where(feishu_target_keywords.c.feishu_target_id == tid))
        for kid in body.keyword_ids:
            if db.get(Keyword, kid):
                db.execute(insert(feishu_target_keywords).values(feishu_target_id=tid, keyword_id=kid))
        db.commit()
    db.refresh(t)
    return _feishu_out(t)


@app.delete("/api/feishu-targets/{tid}")
def delete_feishu(tid: int, db: Session = Depends(get_db), _: None = Depends(verify_admin)):
    t = db.get(FeishuTarget, tid)
    if not t:
        raise HTTPException(404)
    db.delete(t)
    db.commit()
    return {"deleted": True}


@app.post("/api/feishu-targets/{tid}/test")
async def test_feishu(tid: int, db: Session = Depends(get_db), _: None = Depends(verify_admin)):
    t = db.get(FeishuTarget, tid)
    if not t:
        raise HTTPException(404)
    await feishu.send_text(t.webhook_url, "arXiv digest bot: test message OK.")
    return {"ok": True}


@app.post("/api/feishu-targets/{tid}/sample-digest")
async def sample_digest_feishu(
    tid: int,
    body: FeishuPreviewDigestBody,
    db: Session = Depends(get_db),
    _: None = Depends(verify_admin),
):
    t = db.get(FeishuTarget, tid)
    if not t:
        raise HTTPException(404)
    start_date, end_date = _resolve_preview_range(body, t)
    if start_date == end_date:
        all_papers = papers_for_digest(start_date)
    else:
        all_papers = papers_for_date_range(start_date, end_date)
    phrases = _feishu_keyword_phrases(db, t)
    matched = filter_by_keywords(all_papers, phrases)

    if not matched:
        await feishu.send_text(
            t.webhook_url,
            (
                f"arXiv digest preview {start_date} to {end_date} (real API): no matched papers.\n"
                "Tip: add broader keywords (e.g. model, learning, transformer) and try again."
            ),
        )
        return {
            "ok": True,
            "start_date": start_date.isoformat(),
            "end_date": end_date.isoformat(),
            "total_papers_in_range": len(all_papers),
            "matched_papers": 0,
            "sent_lines": 0,
        }

    preview = matched[:5]
    lines = [f"arXiv digest preview {start_date} to {end_date} (real API, top {len(preview)}):", ""]
    for i, p in enumerate(preview, 1):
        lines.append(format_paper_line(p, i))
        lines.append("")
    await feishu.send_text(t.webhook_url, "\n".join(lines).strip())
    return {
        "ok": True,
        "start_date": start_date.isoformat(),
        "end_date": end_date.isoformat(),
        "total_papers_in_range": len(all_papers),
        "matched_papers": len(matched),
        "sent_lines": len(preview),
    }


# --- WeChat settings ---
@app.get("/api/wechat-settings", response_model=WeChatSettingsOut)
def get_wechat_settings(db: Session = Depends(get_db), _: None = Depends(verify_admin)):
    row = _ensure_wechat_settings(db)
    return WeChatSettingsOut(
        app_id=row.app_id,
        template_id=row.template_id,
        field_mapping=row.field_mapping,
        has_app_secret=bool(row.app_secret),
        updated_at=row.updated_at,
    )


@app.patch("/api/wechat-settings", response_model=WeChatSettingsOut)
def patch_wechat_settings(
    body: WeChatSettingsUpdate,
    db: Session = Depends(get_db),
    _: None = Depends(verify_admin),
):
    row = _ensure_wechat_settings(db)
    if body.app_id is not None:
        row.app_id = body.app_id.strip()
    if body.app_secret is not None:
        row.app_secret = body.app_secret.strip()
    if body.template_id is not None:
        row.template_id = body.template_id.strip()
    if body.field_mapping is not None:
        try:
            wechat.parse_field_mapping(body.field_mapping)
        except ValueError as e:
            raise HTTPException(400, str(e))
        row.field_mapping = body.field_mapping
    db.commit()
    db.refresh(row)
    return WeChatSettingsOut(
        app_id=row.app_id,
        template_id=row.template_id,
        field_mapping=row.field_mapping,
        has_app_secret=bool(row.app_secret),
        updated_at=row.updated_at,
    )


# --- WeChat subscribers ---
@app.get("/api/wechat-subscribers", response_model=list[WeChatSubscriberOut])
def list_wechat_subs(db: Session = Depends(get_db), _: None = Depends(verify_admin)):
    rows = db.scalars(select(WeChatSubscriber).order_by(WeChatSubscriber.id)).all()
    return [_wechat_sub_out(s) for s in rows]


@app.post("/api/wechat-subscribers", response_model=WeChatSubscriberOut)
def create_wechat_sub(
    body: WeChatSubscriberCreate,
    db: Session = Depends(get_db),
    _: None = Depends(verify_admin),
):
    oid = body.openid.strip()
    if db.scalars(select(WeChatSubscriber).where(WeChatSubscriber.openid == oid)).first():
        raise HTTPException(409, "openid exists")
    s = WeChatSubscriber(openid=oid, label=(body.label or "").strip(), enabled=body.enabled)
    db.add(s)
    db.commit()
    db.refresh(s)
    if body.keyword_ids:
        for kid in body.keyword_ids:
            if db.get(Keyword, kid):
                db.execute(
                    insert(wechat_subscriber_keywords).values(wechat_subscriber_id=s.id, keyword_id=kid)
                )
        db.commit()
    db.refresh(s)
    return _wechat_sub_out(s)


@app.patch("/api/wechat-subscribers/{sid}", response_model=WeChatSubscriberOut)
def update_wechat_sub(
    sid: int,
    body: WeChatSubscriberUpdate,
    db: Session = Depends(get_db),
    _: None = Depends(verify_admin),
):
    s = db.get(WeChatSubscriber, sid)
    if not s:
        raise HTTPException(404)
    if body.label is not None:
        s.label = body.label.strip()
    if body.enabled is not None:
        s.enabled = body.enabled
    db.commit()
    if body.keyword_ids is not None:
        db.execute(
            delete(wechat_subscriber_keywords).where(
                wechat_subscriber_keywords.c.wechat_subscriber_id == sid
            )
        )
        for kid in body.keyword_ids:
            if db.get(Keyword, kid):
                db.execute(
                    insert(wechat_subscriber_keywords).values(wechat_subscriber_id=s.id, keyword_id=kid)
                )
        db.commit()
    db.refresh(s)
    return _wechat_sub_out(s)


@app.delete("/api/wechat-subscribers/{sid}")
def delete_wechat_sub(sid: int, db: Session = Depends(get_db), _: None = Depends(verify_admin)):
    s = db.get(WeChatSubscriber, sid)
    if not s:
        raise HTTPException(404)
    db.delete(s)
    db.commit()
    return {"deleted": True}


@app.post("/api/wechat-subscribers/{sid}/test")
async def test_wechat_sub(sid: int, db: Session = Depends(get_db), _: None = Depends(verify_admin)):
    row = _ensure_wechat_settings(db)
    app_id = row.app_id or settings.WECHAT_APP_ID
    secret = row.app_secret or settings.WECHAT_APP_SECRET
    template_id = row.template_id or settings.WECHAT_TEMPLATE_ID
    if not app_id or not secret or not template_id:
        raise HTTPException(400, "configure WeChat app_id, secret, template_id")
    s = db.get(WeChatSubscriber, sid)
    if not s:
        raise HTTPException(404)
    token = await wechat.get_access_token(app_id, secret)
    try:
        data = wechat.build_template_data(
            row.field_mapping,
            "arXiv digest test",
            "If you see this, template mapping works.",
            "https://arxiv.org",
        )
    except ValueError as e:
        raise HTTPException(400, str(e))
    resp = await wechat.send_template_message(token, s.openid, template_id, data, url="https://arxiv.org")
    if resp.get("errcode") not in (0, None):
        raise HTTPException(502, detail=str(resp))
    return {"ok": True, "response": resp}


# --- Digest ---
@app.post("/api/digest/run", response_model=DigestRunResult)
async def run_digest_endpoint(
    body: DigestRunBody,
    db: Session = Depends(get_db),
    _: None = Depends(verify_admin),
):
    out = await digest_runner.run_digest(db, force=body.force, dry_run=body.dry_run)
    return DigestRunResult(**out)


@app.get("/api/digest/preview")
def preview_digest(db: Session = Depends(get_db), _: None = Depends(verify_admin)):
    d = digest_calendar_date()
    papers = papers_for_digest(d)
    all_kw = db.scalars(select(Keyword).order_by(Keyword.id)).all()
    phrases = [k.phrase for k in all_kw]
    matched = filter_by_keywords(papers, phrases)
    return {
        "digest_date": d.isoformat(),
        "total_papers_that_day": len(papers),
        "matched_with_global_keywords": len(matched),
        "sample": [
            {"id": p.arxiv_id, "title": p.title[:120], "abs_url": p.abs_url} for p in matched[:10]
        ],
    }


_frontend_dist = Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"
if _frontend_dist.is_dir():
    app.mount("/", StaticFiles(directory=str(_frontend_dist), html=True), name="frontend")
