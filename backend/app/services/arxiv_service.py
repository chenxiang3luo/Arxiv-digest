from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import arxiv

from app.config import settings


@dataclass
class Paper:
    arxiv_id: str
    title: str
    abstract: str
    authors: str
    published: datetime
    abs_url: str
    pdf_url: str


def digest_calendar_date() -> date:
    tz = ZoneInfo(settings.DIGEST_TIMEZONE)
    now = datetime.now(tz)
    return (now.date() - timedelta(days=settings.DIGEST_OFFSET_DAYS))


def _to_shanghai_date(dt: datetime) -> date:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(ZoneInfo(settings.DIGEST_TIMEZONE)).date()


def _build_query() -> str:
    base = (settings.ARXIV_QUERY_BASE or "").strip()
    return base if base else "all"


def papers_for_digest(digest_date: date) -> list[Paper]:
    """Fetch recent arXiv results and keep those whose v1 published date is digest_date in Shanghai TZ."""
    query = _build_query()
    search = arxiv.Search(
        query=query,
        max_results=settings.ARXIV_MAX_FETCH,
        sort_by=arxiv.SortCriterion.SubmittedDate,
        sort_order=arxiv.SortOrder.Descending,
    )
    client = arxiv.Client()
    out: list[Paper] = []
    for r in client.results(search):
        pub = r.published
        if pub is None:
            continue
        if _to_shanghai_date(pub) != digest_date:
            continue
        aid = r.entry_id.split("/abs/")[-1].split("v")[0]
        authors = ", ".join(a.name for a in r.authors) if r.authors else ""
        out.append(
            Paper(
                arxiv_id=aid,
                title=(r.title or "").replace("\n", " ").strip(),
                abstract=(r.summary or "").replace("\n", " ").strip(),
                authors=authors,
                published=pub,
                abs_url=r.entry_id,
                pdf_url=r.pdf_url or r.entry_id.replace("/abs/", "/pdf/"),
            )
        )
    # Dedupe by id (shouldn't happen)
    seen: set[str] = set()
    deduped: list[Paper] = []
    for p in out:
        if p.arxiv_id in seen:
            continue
        seen.add(p.arxiv_id)
        deduped.append(p)
    return deduped


def papers_for_date_range(start_date: date, end_date: date, max_days: int = 14) -> list[Paper]:
    if end_date < start_date:
        return []
    day_count = (end_date - start_date).days + 1
    if day_count > max_days:
        raise ValueError(f"date range too large: {day_count} days (max {max_days})")

    all_papers: list[Paper] = []
    cursor = start_date
    while cursor <= end_date:
        all_papers.extend(papers_for_digest(cursor))
        cursor += timedelta(days=1)

    # Dedupe by arXiv id across dates and keep latest published first.
    all_papers.sort(key=lambda x: x.published, reverse=True)
    seen: set[str] = set()
    out: list[Paper] = []
    for p in all_papers:
        if p.arxiv_id in seen:
            continue
        seen.add(p.arxiv_id)
        out.append(p)
    return out


def filter_by_keywords(papers: list[Paper], phrases: list[str]) -> list[Paper]:
    if not phrases:
        return []
    lowered = [p.lower() for p in phrases]
    matched: list[Paper] = []
    for paper in papers:
        blob = f"{paper.title}\n{paper.abstract}".lower()
        if any(k in blob for k in lowered):
            matched.append(paper)
    return matched


def _short_authors(authors: str, max_authors: int = 3) -> str:
    parts = [a.strip() for a in (authors or "").split(",") if a.strip()]
    if not parts:
        return "Unknown authors"
    if len(parts) <= max_authors:
        return ", ".join(parts)
    return f"{', '.join(parts[:max_authors])}, +{len(parts) - max_authors} more"


def _short_abstract(abstract: str, max_len: int = 220) -> str:
    text = (abstract or "").strip().replace("\n", " ")
    if not text:
        return "(no abstract)"
    if len(text) <= max_len:
        return text
    return text[: max_len - 3].rstrip() + "..."


def format_paper_line(p: Paper, index: int) -> str:
    return (
        f"{index}. {p.title}\n"
        f"   Authors: {_short_authors(p.authors)}\n"
        f"   Abstract: {_short_abstract(p.abstract)}\n"
        f"   {p.abs_url}"
    )
