import logging

import httpx

logger = logging.getLogger(__name__)


async def send_text(webhook_url: str, text: str) -> None:
    if not webhook_url.startswith("https://"):
        raise ValueError("Feishu webhook must use https")
    payload = {"msg_type": "text", "content": {"text": text}}
    async with httpx.AsyncClient(timeout=30.0) as client:
        r = await client.post(webhook_url, json=payload)
        r.raise_for_status()
        try:
            data = r.json()
        except Exception:
            return
    if not isinstance(data, dict):
        return
    code = data.get("code")
    status_code = data.get("StatusCode")
    if code not in (None, 0):
        raise RuntimeError(f"Feishu API error: {data}")
    if status_code not in (None, 0):
        raise RuntimeError(f"Feishu API error: {data}")
