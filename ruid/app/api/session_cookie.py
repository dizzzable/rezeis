from __future__ import annotations

from fastapi import Response

from app.core.config import Settings


def clear_session_cookie(response: Response, settings: Settings) -> None:
    response.delete_cookie(
        key=settings.ruid_session_cookie_name,
        domain=settings.ruid_session_cookie_domain,
        path=settings.ruid_session_cookie_path,
        secure=settings.ruid_session_cookie_secure,
        httponly=True,
        samesite=settings.ruid_session_cookie_samesite,
    )
