import asyncio
import json
import logging
import time
from typing import Any

import httpx

logger = logging.getLogger(__name__)

# Cache token per app_id so switching credentials in admin works immediately.
_token_cache: dict[str, tuple[str, float]] = {}
_lock = asyncio.Lock()


async def get_access_token(app_id: str, app_secret: str) -> str:
    if not app_id or not app_secret:
        raise ValueError("WeChat app_id and app_secret required")
    async with _lock:
        now = time.monotonic()
        cached = _token_cache.get(app_id)
        if cached and now < cached[1] - 60:
            return cached[0]
        url = "https://api.weixin.qq.com/cgi-bin/token"
        params = {"grant_type": "client_credential", "appid": app_id, "secret": app_secret}
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.get(url, params=params)
            r.raise_for_status()
            data = r.json()
        if "access_token" not in data:
            raise RuntimeError(f"WeChat token error: {data}")
        token = data["access_token"]
        expires = int(data.get("expires_in", 7200))
        _token_cache[app_id] = (token, time.monotonic() + expires)
        return token


def parse_field_mapping(field_mapping_json: str) -> dict[str, str]:
    try:
        raw = json.loads(field_mapping_json or "{}")
    except json.JSONDecodeError as exc:
        raise ValueError(f"field_mapping must be valid JSON: {exc.msg}") from exc
    if not isinstance(raw, dict):
        raise ValueError("field_mapping must be a JSON object")

    out: dict[str, str] = {}
    for k, v in raw.items():
        if not isinstance(k, str) or not isinstance(v, str):
            raise ValueError("field_mapping keys and values must be strings")
        key = k.strip()
        value = v.strip()
        if not key or not value:
            raise ValueError("field_mapping keys and values cannot be empty")
        out[key] = value
    return out


def build_template_data(
    field_mapping_json: str,
    digest_title: str,
    digest_body: str,
    link: str,
) -> dict[str, dict[str, str]]:
    mapping = parse_field_mapping(field_mapping_json)
    values = {
        "digest_title": digest_title[:120],
        "digest_body": digest_body[:500],
        "link": link[:500],
    }
    out: dict[str, dict[str, str]] = {}
    for logical, wx_key in mapping.items():
        if logical not in values:
            continue
        out[wx_key] = {"value": values[logical]}
    return out


async def send_template_message(
    access_token: str,
    openid: str,
    template_id: str,
    data: dict[str, dict[str, str]],
    url: str | None = None,
) -> dict[str, Any]:
    api = "https://api.weixin.qq.com/cgi-bin/message/template/send"
    params = {"access_token": access_token}
    body: dict[str, Any] = {
        "touser": openid,
        "template_id": template_id,
        "data": data,
    }
    if url:
        body["url"] = url
    async with httpx.AsyncClient(timeout=30.0) as client:
        r = await client.post(api, params=params, json=body)
        r.raise_for_status()
        return r.json()
