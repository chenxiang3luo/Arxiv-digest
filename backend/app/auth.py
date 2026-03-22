from fastapi import Depends, HTTPException, Security
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.config import settings

bearer = HTTPBearer(auto_error=False)


def verify_admin(
    creds: HTTPAuthorizationCredentials | None = Security(bearer),
) -> None:
    if not creds or creds.credentials != settings.ADMIN_TOKEN:
        raise HTTPException(status_code=401, detail="Invalid or missing admin token")
