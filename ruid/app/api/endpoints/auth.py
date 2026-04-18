from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Response

from app.api.dependencies import (
    get_runtime_settings,
    get_session_service,
    get_session_store,
    get_subscription_service,
    get_telegram_auth_init_data,
    get_telegram_auth_service,
    raise_bff_http_error,
    validate_browser_origin,
)
from app.core.config import Settings
from app.schemas.auth_session import AuthSessionSchema
from app.schemas.bootstrap import TelegramBootstrapResponseSchema
from app.services.session_service import SessionService
from app.services.internal_admin_client import InternalAdminError
from app.services.session_store import RedisSessionStore
from app.services.subscription_service import SubscriptionService
from app.services.telegram_auth_service import ReplayTelegramInitDataError, TelegramAuthService

router: APIRouter = APIRouter(prefix="/auth/telegram")


@router.post("/bootstrap", response_model=TelegramBootstrapResponseSchema)
async def bootstrap_telegram_session(
    response: Response,
    _: Annotated[None, Depends(validate_browser_origin)],
    raw_init_data: Annotated[str, Depends(get_telegram_auth_init_data)],
    telegram_auth_service: Annotated[TelegramAuthService, Depends(get_telegram_auth_service)],
    session_store: Annotated[RedisSessionStore, Depends(get_session_store)],
    session_service: Annotated[SessionService, Depends(get_session_service)],
    subscription_service: Annotated[SubscriptionService, Depends(get_subscription_service)],
    settings: Annotated[Settings, Depends(get_runtime_settings)],
) -> TelegramBootstrapResponseSchema:
    subscription = None
    try:
        telegram_session = telegram_auth_service.validate_init_data(raw_init_data)
        session = await session_service.get_session_by_telegram_id(telegram_session.telegram_id)
        proof_ttl_seconds = max(
            1,
            settings.telegram_auth_max_age_seconds
            - int((datetime.now(tz=UTC) - telegram_session.auth_date).total_seconds()),
        )
        was_reserved = await session_store.reserve_bootstrap_proof(raw_init_data, proof_ttl_seconds)
        if not was_reserved:
            raise ReplayTelegramInitDataError(
                "Telegram init data was already used to create a session."
            )
    except Exception as err:
        raise_bff_http_error(err)
    session_id = await session_store.create_session(
        AuthSessionSchema.model_validate(
            {
                "userId": session.id,
                "telegramId": telegram_session.telegram_id,
                "createdAt": datetime.now(tz=UTC),
            },
        ),
    )
    response.set_cookie(
        key=settings.ruid_session_cookie_name,
        value=session_id,
        max_age=settings.ruid_session_ttl_seconds,
        httponly=True,
        secure=settings.ruid_session_cookie_secure,
        samesite=settings.ruid_session_cookie_samesite,
        domain=settings.ruid_session_cookie_domain,
        path=settings.ruid_session_cookie_path,
    )
    try:
        subscription = await subscription_service.get_subscription_by_user_id(session.id)
    except InternalAdminError:
        subscription = None
    return TelegramBootstrapResponseSchema.model_validate(
        {
            "session": session.model_dump(mode="json", by_alias=True),
            "subscription": None
            if subscription is None
            else subscription.model_dump(mode="json", by_alias=True),
            "expiresIn": settings.ruid_session_ttl_seconds,
        },
    )
