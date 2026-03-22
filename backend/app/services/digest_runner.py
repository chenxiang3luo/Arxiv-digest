import asyncio
import logging
from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.models import DigestRun, FeishuTarget, Keyword, WeChatSettings, WeChatSubscriber
from app.services import arxiv_service, feishu, wechat

logger = logging.getLogger(__name__)


def _keyword_phrases_for_feishu(db: Session, target: FeishuTarget) -> list[str]:
    if target.keywords:
        return [k.phrase for k in target.keywords]
    all_k = db.scalars(select(Keyword).order_by(Keyword.id)).all()
    return [k.phrase for k in all_k]


def _keyword_phrases_for_subscriber(db: Session, sub: WeChatSubscriber) -> list[str]:
    if sub.keywords:
        return [k.phrase for k in sub.keywords]
    all_k = db.scalars(select(Keyword).order_by(Keyword.id)).all()
    return [k.phrase for k in all_k]


def _already_ran(db: Session, digest_date: str, rtype: str, rid: int) -> bool:
    row = db.execute(
        select(DigestRun).where(
            DigestRun.digest_date == digest_date,
            DigestRun.recipient_type == rtype,
            DigestRun.recipient_id == rid,
        )
    ).scalar_one_or_none()
    return row is not None and row.status == "success"


def _record_run(
    db: Session,
    digest_date: str,
    rtype: str,
    rid: int,
    status: str,
    paper_count: int,
    error: str = "",
) -> None:
    existing = db.execute(
        select(DigestRun).where(
            DigestRun.digest_date == digest_date,
            DigestRun.recipient_type == rtype,
            DigestRun.recipient_id == rid,
        )
    ).scalar_one_or_none()
    if existing:
        existing.status = status
        existing.paper_count = paper_count
        existing.error_message = error
    else:
        db.add(
            DigestRun(
                digest_date=digest_date,
                recipient_type=rtype,
                recipient_id=rid,
                status=status,
                paper_count=paper_count,
                error_message=error,
            )
        )
    db.commit()


def _format_digest_text(matched: list, digest_date: date) -> str:
    if not matched:
        return ""
    lines = [f"arXiv digest {digest_date} (Asia/Shanghai, keyword-matched):", ""]
    for i, p in enumerate(matched, 1):
        lines.append(arxiv_service.format_paper_line(p, i))
        lines.append("")
    return "\n".join(lines).strip()


async def run_digest(db: Session, *, force: bool = False, dry_run: bool = False) -> dict:
    d = arxiv_service.digest_calendar_date()
    digest_date_str = d.isoformat()
    results: list[dict] = []

    all_papers = arxiv_service.papers_for_digest(d)
    logger.info("Fetched %s papers for digest_date=%s", len(all_papers), digest_date_str)

    # Feishu targets
    targets = db.scalars(select(FeishuTarget).where(FeishuTarget.enabled == True)).all()  # noqa: E712
    for t in targets:
        if not force and _already_ran(db, digest_date_str, "feishu", t.id):
            results.append(
                {"channel": "feishu", "id": t.id, "name": t.name, "status": "skipped", "reason": "already_sent"}
            )
            continue
        phrases = _keyword_phrases_for_feishu(db, t)
        matched = arxiv_service.filter_by_keywords(all_papers, phrases)
        if not matched:
            _record_run(db, digest_date_str, "feishu", t.id, "skipped", 0, "no_matching_papers")
            results.append(
                {"channel": "feishu", "id": t.id, "name": t.name, "status": "skipped", "paper_count": 0}
            )
            continue
        text = _format_digest_text(matched, d)
        if dry_run:
            results.append(
                {
                    "channel": "feishu",
                    "id": t.id,
                    "name": t.name,
                    "status": "dry_run",
                    "paper_count": len(matched),
                }
            )
            continue
        try:
            await feishu.send_text(t.webhook_url, text)
            _record_run(db, digest_date_str, "feishu", t.id, "success", len(matched), "")
            results.append(
                {"channel": "feishu", "id": t.id, "name": t.name, "status": "success", "paper_count": len(matched)}
            )
        except Exception as e:
            logger.exception("Feishu send failed target=%s", t.id)
            _record_run(db, digest_date_str, "feishu", t.id, "failed", len(matched), str(e))
            results.append(
                {"channel": "feishu", "id": t.id, "name": t.name, "status": "failed", "error": str(e)}
            )

    # WeChat subscribers
    wx_row = db.scalars(select(WeChatSettings).limit(1)).first()
    app_id = (wx_row.app_id if wx_row and wx_row.app_id else settings.WECHAT_APP_ID) or ""
    app_secret = (wx_row.app_secret if wx_row and wx_row.app_secret else settings.WECHAT_APP_SECRET) or ""
    template_id = (wx_row.template_id if wx_row and wx_row.template_id else settings.WECHAT_TEMPLATE_ID) or ""
    field_mapping = (
        wx_row.field_mapping
        if wx_row and wx_row.field_mapping
        else '{"digest_title":"thing1","digest_body":"thing2","link":"url"}'
    )

    subs = db.scalars(select(WeChatSubscriber).where(WeChatSubscriber.enabled == True)).all()  # noqa: E712
    if subs and (not app_id or not app_secret or not template_id):
        for s in subs:
            results.append(
                {
                    "channel": "wechat",
                    "id": s.id,
                    "openid": s.openid[:8] + "…",
                    "status": "skipped",
                    "reason": "wechat_not_configured",
                }
            )
    elif subs:
        try:
            token = await wechat.get_access_token(app_id, app_secret)
        except Exception as e:
            logger.exception("WeChat token fetch failed")
            for s in subs:
                _record_run(db, digest_date_str, "wechat", s.id, "failed", 0, str(e))
                results.append(
                    {
                        "channel": "wechat",
                        "id": s.id,
                        "status": "failed",
                        "error": f"token_error: {e}",
                    }
                )
            return {"digest_date": digest_date_str, "results": results}
        for s in subs:
            if not force and _already_ran(db, digest_date_str, "wechat", s.id):
                results.append(
                    {
                        "channel": "wechat",
                        "id": s.id,
                        "status": "skipped",
                        "reason": "already_sent",
                    }
                )
                continue
            phrases = _keyword_phrases_for_subscriber(db, s)
            matched = arxiv_service.filter_by_keywords(all_papers, phrases)
            if not matched:
                _record_run(db, digest_date_str, "wechat", s.id, "skipped", 0, "no_matching_papers")
                results.append({"channel": "wechat", "id": s.id, "status": "skipped", "paper_count": 0})
                continue
            title = f"arXiv {digest_date_str} · {len(matched)} paper(s)"
            body_lines = [arxiv_service.format_paper_line(p, i) for i, p in enumerate(matched, 1)]
            body = "\n".join(body_lines)[:500]
            link = matched[0].abs_url
            try:
                data = wechat.build_template_data(field_mapping, title, body, link)
            except ValueError as e:
                _record_run(db, digest_date_str, "wechat", s.id, "failed", len(matched), str(e))
                results.append({"channel": "wechat", "id": s.id, "status": "failed", "error": str(e)})
                continue
            if dry_run:
                results.append(
                    {
                        "channel": "wechat",
                        "id": s.id,
                        "status": "dry_run",
                        "paper_count": len(matched),
                    }
                )
                continue
            try:
                resp = await wechat.send_template_message(token, s.openid, template_id, data, url=link)
                if resp.get("errcode") not in (0, None):
                    raise RuntimeError(resp)
                _record_run(db, digest_date_str, "wechat", s.id, "success", len(matched), "")
                results.append(
                    {"channel": "wechat", "id": s.id, "status": "success", "paper_count": len(matched)}
                )
                await asyncio.sleep(0.15)
            except Exception as e:
                logger.exception("WeChat send failed subscriber=%s", s.id)
                _record_run(db, digest_date_str, "wechat", s.id, "failed", len(matched), str(e))
                results.append({"channel": "wechat", "id": s.id, "status": "failed", "error": str(e)})

    return {"digest_date": digest_date_str, "results": results}
