from __future__ import annotations

from typing import Annotated

from fastapi import Depends, FastAPI, Header, HTTPException, Request, Response, status
from redis.asyncio import Redis

from app.api.session_cookie import clear_session_cookie
from app.core.config import Settings, get_settings
from app.schemas.auth_session import AuthSessionSchema
from app.services.internal_admin_client import (
    InternalAdminClient,
    InternalAdminContractError,
    InternalAdminNotFoundError,
    InternalAdminTimeoutError,
    InternalAdminUpstreamError,
    build_internal_admin_client,
)
from app.services.platform_policy_service import PlatformPolicyService
from app.services.plans_service import PlansService
from app.services.session_service import SessionService
from app.services.session_store import RedisSessionStore
from app.services.subscription_service import SubscriptionService
from app.services.telegram_auth_service import (
    ExpiredTelegramInitDataError,
    InvalidTelegramInitDataError,
    ReplayTelegramInitDataError,
    TelegramAuthService,
)


def get_internal_admin_client(request: Request) -> InternalAdminClient:
    return request.app.state.internal_admin_client


def set_internal_admin_client_state(app: FastAPI) -> None:
    if hasattr(app.state, "internal_admin_client"):
        return
    settings = get_settings()
    app.state.internal_admin_client = build_internal_admin_client(
        base_url=settings.get_rezeis_base_url(),
        internal_api_key=settings.rezeis_internal_api_key,
    )


def get_redis_client(request: Request) -> Redis:
    return request.app.state.redis_client


def set_session_store_state(app: FastAPI) -> None:
    if hasattr(app.state, "session_store"):
        return
    settings = get_settings()
    redis_client = Redis.from_url(settings.redis_url, decode_responses=True)
    app.state.redis_client = redis_client
    app.state.session_store = RedisSessionStore(
        redis_client=redis_client,
        key_prefix=settings.ruid_session_key_prefix,
        ttl_seconds=settings.ruid_session_ttl_seconds,
        bootstrap_proof_key_suffix=settings.ruid_bootstrap_proof_key_suffix,
    )


def get_runtime_settings() -> Settings:
    return get_settings()


def get_session_store(request: Request) -> RedisSessionStore:
    return request.app.state.session_store


def get_telegram_auth_service(
    settings: Annotated[Settings, Depends(get_runtime_settings)],
) -> TelegramAuthService:
    if settings.telegram_bot_token is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Telegram authentication is not configured.",
        )
    return TelegramAuthService(
        bot_token=settings.telegram_bot_token,
        auth_max_age_seconds=settings.telegram_auth_max_age_seconds,
    )


def get_session_service(
    client: Annotated[InternalAdminClient, Depends(get_internal_admin_client)],
) -> SessionService:
    return SessionService(client)


def get_plans_service(
    client: Annotated[InternalAdminClient, Depends(get_internal_admin_client)],
) -> PlansService:
    return PlansService(client)


def get_platform_policy_service(
    client: Annotated[InternalAdminClient, Depends(get_internal_admin_client)],
) -> PlatformPolicyService:
    return PlatformPolicyService(client)


def get_subscription_service(
    client: Annotated[InternalAdminClient, Depends(get_internal_admin_client)],
) -> SubscriptionService:
    return SubscriptionService(client)


def get_telegram_auth_init_data(
    authorization: Annotated[str | None, Header()] = None,
) -> str:
    if authorization is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing Telegram Mini App authorization header.",
        )
    auth_scheme, _, raw_value = authorization.partition(" ")
    if auth_scheme.lower() != "tma" or raw_value == "":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid Telegram Mini App authorization header.",
        )
    return raw_value


def validate_browser_origin(
    request: Request,
    settings: Annotated[Settings, Depends(get_runtime_settings)],
) -> None:
    allowed_origins = settings.get_browser_allowed_origins()
    if len(allowed_origins) == 0:
        return
    origin = request.headers.get("origin")
    if origin is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Browser origin header is required.",
        )
    if settings.is_allowed_browser_origin(origin):
        return
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="Browser origin is not allowed.",
    )


async def get_current_auth_session(
    request: Request,
    response: Response,
    session_store: Annotated[RedisSessionStore, Depends(get_session_store)],
    settings: Annotated[Settings, Depends(get_runtime_settings)],
) -> AuthSessionSchema:
    session_cookie = request.cookies.get(settings.ruid_session_cookie_name)
    if session_cookie is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required.",
        )
    auth_session = await session_store.get_session(session_cookie)
    if auth_session is None:
        clear_session_cookie(response, settings)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Session is missing or expired.",
        )
    return auth_session


def raise_bff_http_error(err: Exception) -> None:
    if isinstance(
        err,
        (InvalidTelegramInitDataError, ExpiredTelegramInitDataError, ReplayTelegramInitDataError),
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=str(err),
        ) from err
    if isinstance(err, InternalAdminNotFoundError):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found") from err
    if isinstance(err, InternalAdminTimeoutError):
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail="Internal admin request timed out",
        ) from err
    if isinstance(err, InternalAdminUpstreamError):
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Internal admin request failed",
        ) from err
    if isinstance(err, InternalAdminContractError):
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Internal admin returned an invalid contract payload",
        ) from err
    raise err
