from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status

from app.api.session_cookie import clear_session_cookie
from app.api.dependencies import (
    get_current_auth_session,
    get_runtime_settings,
    get_session_store,
    get_subscription_service,
    raise_bff_http_error,
)
from app.core.config import Settings
from app.schemas.auth_session import AuthSessionSchema
from app.schemas.subscription import SubscriptionSchema
from app.services.internal_admin_client import InternalAdminNotFoundError
from app.services.session_store import RedisSessionStore
from app.services.subscription_service import SubscriptionService

router: APIRouter = APIRouter(prefix="/subscription")


@router.get("", response_model=SubscriptionSchema | None)
async def get_subscription(
    request: Request,
    response: Response,
    auth_session: Annotated[AuthSessionSchema, Depends(get_current_auth_session)],
    service: Annotated[SubscriptionService, Depends(get_subscription_service)],
    session_store: Annotated[RedisSessionStore, Depends(get_session_store)],
    settings: Annotated[Settings, Depends(get_runtime_settings)],
) -> SubscriptionSchema | None:
    try:
        return await service.get_subscription_by_user_id(auth_session.user_id)
    except InternalAdminNotFoundError as err:
        session_cookie = request.cookies.get(settings.ruid_session_cookie_name)
        if session_cookie is not None:
            await session_store.delete_session(session_cookie)
        clear_session_cookie(response, settings)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Session is no longer valid.",
        ) from err
    except Exception as err:
        raise_bff_http_error(err)
