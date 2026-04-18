from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import ValidationError

from app.api.session_cookie import clear_session_cookie
from app.api.dependencies import (
    get_current_auth_session,
    get_runtime_settings,
    get_session_service,
    get_session_store,
    raise_bff_http_error,
)
from app.core.config import Settings
from app.schemas.auth_session import AuthSessionSchema
from app.schemas.session import SessionSchema
from app.schemas.session_web_account_email_verification_completion import (
    SessionWebAccountEmailVerificationCompletionSchema,
)
from app.schemas.session_web_account_password import SessionWebAccountPasswordSchema
from app.schemas.web_account_email_verification_challenge import (
    WebAccountEmailVerificationChallengeSchema,
)
from app.services.internal_admin_client import (
    InternalAdminActionablePasswordHandoffError,
    InternalAdminActionableEmailVerificationCompletionError,
    InternalAdminContractError,
    InternalAdminNonActionablePromptError,
    InternalAdminNotFoundError,
)
from app.services.session_service import SessionService
from app.services.session_store import RedisSessionStore

router: APIRouter = APIRouter(prefix="/session")


async def invalidate_stale_session(
    *,
    request: Request,
    response: Response,
    session_store: RedisSessionStore,
    settings: Settings,
) -> None:
    session_cookie = request.cookies.get(settings.ruid_session_cookie_name)
    if session_cookie is not None:
        await session_store.delete_session(session_cookie)
    clear_session_cookie(response, settings)


async def get_refreshed_session_after_non_actionable_write(
    *,
    user_id: str,
    request: Request,
    response: Response,
    service: SessionService,
    session_store: RedisSessionStore,
    settings: Settings,
) -> SessionSchema:
    try:
        return await service.get_session_by_user_id(user_id)
    except InternalAdminNotFoundError as err:
        await invalidate_stale_session(
            request=request,
            response=response,
            session_store=session_store,
            settings=settings,
        )
        raise_invalid_session_http_error(err)
    except InternalAdminContractError as err:
        await invalidate_stale_session(
            request=request,
            response=response,
            session_store=session_store,
            settings=settings,
        )
        raise_invalid_session_http_error(err)
    except Exception as err:
        raise_bff_http_error(err)


def build_email_verification_challenge_from_session(
    session: SessionSchema,
) -> WebAccountEmailVerificationChallengeSchema:
    web_account = session.web_account
    if web_account is None:
        return WebAccountEmailVerificationChallengeSchema(
            webAccountId=None,
            email=None,
            challengeExpiresAt=None,
            emailVerifiedAt=None,
        )
    email = web_account.email or web_account.email_normalized
    return WebAccountEmailVerificationChallengeSchema(
        webAccountId=web_account.id,
        email=email,
        challengeExpiresAt=None,
        emailVerifiedAt=web_account.email_verified_at,
    )


def raise_invalid_session_http_error(err: Exception) -> None:
    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Session is no longer valid.",
    ) from err


async def get_valid_auth_session_user_id(
    *,
    auth_session: object,
    request: Request,
    response: Response,
    session_store: RedisSessionStore,
    settings: Settings,
) -> str:
    try:
        return AuthSessionSchema.model_validate(auth_session).user_id
    except ValidationError as err:
        await invalidate_stale_session(
            request=request,
            response=response,
            session_store=session_store,
            settings=settings,
        )
        raise_invalid_session_http_error(err)


@router.get("", response_model=SessionSchema)
async def get_session(
    request: Request,
    response: Response,
    auth_session: Annotated[AuthSessionSchema, Depends(get_current_auth_session)],
    service: Annotated[SessionService, Depends(get_session_service)],
    session_store: Annotated[RedisSessionStore, Depends(get_session_store)],
    settings: Annotated[Settings, Depends(get_runtime_settings)],
) -> SessionSchema:
    user_id = await get_valid_auth_session_user_id(
        auth_session=auth_session,
        request=request,
        response=response,
        session_store=session_store,
        settings=settings,
    )
    try:
        return await service.get_session_by_user_id(user_id)
    except InternalAdminNotFoundError as err:
        await invalidate_stale_session(
            request=request,
            response=response,
            session_store=session_store,
            settings=settings,
        )
        raise_invalid_session_http_error(err)
    except InternalAdminContractError as err:
        await invalidate_stale_session(
            request=request,
            response=response,
            session_store=session_store,
            settings=settings,
        )
        raise_invalid_session_http_error(err)
    except Exception as err:
        raise_bff_http_error(err)


@router.patch("/rules-acceptance", response_model=SessionSchema)
async def accept_rules(
    request: Request,
    response: Response,
    auth_session: Annotated[AuthSessionSchema, Depends(get_current_auth_session)],
    service: Annotated[SessionService, Depends(get_session_service)],
    session_store: Annotated[RedisSessionStore, Depends(get_session_store)],
    settings: Annotated[Settings, Depends(get_runtime_settings)],
) -> SessionSchema:
    user_id = await get_valid_auth_session_user_id(
        auth_session=auth_session,
        request=request,
        response=response,
        session_store=session_store,
        settings=settings,
    )
    try:
        return await service.accept_rules_by_user_id(user_id)
    except InternalAdminNotFoundError as err:
        await invalidate_stale_session(
            request=request,
            response=response,
            session_store=session_store,
            settings=settings,
        )
        raise_invalid_session_http_error(err)
    except InternalAdminContractError as err:
        await invalidate_stale_session(
            request=request,
            response=response,
            session_store=session_store,
            settings=settings,
        )
        raise_invalid_session_http_error(err)
    except Exception as err:
        raise_bff_http_error(err)


@router.patch("/web-account-link-prompt-snooze", response_model=SessionSchema)
async def snooze_web_account_link_prompt(
    request: Request,
    response: Response,
    auth_session: Annotated[AuthSessionSchema, Depends(get_current_auth_session)],
    service: Annotated[SessionService, Depends(get_session_service)],
    session_store: Annotated[RedisSessionStore, Depends(get_session_store)],
    settings: Annotated[Settings, Depends(get_runtime_settings)],
) -> SessionSchema:
    user_id = await get_valid_auth_session_user_id(
        auth_session=auth_session,
        request=request,
        response=response,
        session_store=session_store,
        settings=settings,
    )
    try:
        return await service.snooze_web_account_link_prompt_by_user_id(user_id)
    except InternalAdminNonActionablePromptError:
        return await get_refreshed_session_after_non_actionable_write(
            user_id=user_id,
            request=request,
            response=response,
            service=service,
            session_store=session_store,
            settings=settings,
        )
    except InternalAdminNotFoundError as err:
        await invalidate_stale_session(
            request=request,
            response=response,
            session_store=session_store,
            settings=settings,
        )
        raise_invalid_session_http_error(err)
    except InternalAdminContractError as err:
        await invalidate_stale_session(
            request=request,
            response=response,
            session_store=session_store,
            settings=settings,
        )
        raise_invalid_session_http_error(err)
    except Exception as err:
        raise_bff_http_error(err)


@router.patch("/web-account-password", response_model=SessionSchema)
async def handoff_web_account_password(
    input: SessionWebAccountPasswordSchema,
    request: Request,
    response: Response,
    auth_session: Annotated[AuthSessionSchema, Depends(get_current_auth_session)],
    service: Annotated[SessionService, Depends(get_session_service)],
    session_store: Annotated[RedisSessionStore, Depends(get_session_store)],
    settings: Annotated[Settings, Depends(get_runtime_settings)],
) -> SessionSchema:
    user_id = await get_valid_auth_session_user_id(
        auth_session=auth_session,
        request=request,
        response=response,
        session_store=session_store,
        settings=settings,
    )
    try:
        return await service.handoff_web_account_password_by_user_id(user_id, input)
    except InternalAdminActionablePasswordHandoffError as err:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=err.detail) from err
    except InternalAdminNonActionablePromptError:
        return await get_refreshed_session_after_non_actionable_write(
            user_id=user_id,
            request=request,
            response=response,
            service=service,
            session_store=session_store,
            settings=settings,
        )
    except InternalAdminNotFoundError as err:
        await invalidate_stale_session(
            request=request,
            response=response,
            session_store=session_store,
            settings=settings,
        )
        raise_invalid_session_http_error(err)
    except InternalAdminContractError as err:
        await invalidate_stale_session(
            request=request,
            response=response,
            session_store=session_store,
            settings=settings,
        )
        raise_invalid_session_http_error(err)
    except Exception as err:
        raise_bff_http_error(err)


@router.patch(
    "/web-account-email-verification-challenge",
    response_model=WebAccountEmailVerificationChallengeSchema,
)
async def issue_web_account_email_verification_challenge(
    request: Request,
    response: Response,
    auth_session: Annotated[AuthSessionSchema, Depends(get_current_auth_session)],
    service: Annotated[SessionService, Depends(get_session_service)],
    session_store: Annotated[RedisSessionStore, Depends(get_session_store)],
    settings: Annotated[Settings, Depends(get_runtime_settings)],
) -> WebAccountEmailVerificationChallengeSchema:
    user_id = await get_valid_auth_session_user_id(
        auth_session=auth_session,
        request=request,
        response=response,
        session_store=session_store,
        settings=settings,
    )
    try:
        return await service.issue_web_account_email_verification_challenge_by_user_id(user_id)
    except InternalAdminNonActionablePromptError:
        refreshed_session = await get_refreshed_session_after_non_actionable_write(
            user_id=user_id,
            request=request,
            response=response,
            service=service,
            session_store=session_store,
            settings=settings,
        )
        return build_email_verification_challenge_from_session(refreshed_session)
    except InternalAdminNotFoundError as err:
        await invalidate_stale_session(
            request=request,
            response=response,
            session_store=session_store,
            settings=settings,
        )
        raise_invalid_session_http_error(err)
    except InternalAdminContractError as err:
        await invalidate_stale_session(
            request=request,
            response=response,
            session_store=session_store,
            settings=settings,
        )
        raise_invalid_session_http_error(err)
    except Exception as err:
        raise_bff_http_error(err)


@router.patch("/web-account-email-verification-completion", response_model=SessionSchema)
async def complete_web_account_email_verification(
    input: SessionWebAccountEmailVerificationCompletionSchema,
    request: Request,
    response: Response,
    auth_session: Annotated[AuthSessionSchema, Depends(get_current_auth_session)],
    service: Annotated[SessionService, Depends(get_session_service)],
    session_store: Annotated[RedisSessionStore, Depends(get_session_store)],
    settings: Annotated[Settings, Depends(get_runtime_settings)],
) -> SessionSchema:
    user_id = await get_valid_auth_session_user_id(
        auth_session=auth_session,
        request=request,
        response=response,
        session_store=session_store,
        settings=settings,
    )
    try:
        return await service.complete_web_account_email_verification_by_user_id(user_id, input)
    except InternalAdminNonActionablePromptError:
        return await get_refreshed_session_after_non_actionable_write(
            user_id=user_id,
            request=request,
            response=response,
            service=service,
            session_store=session_store,
            settings=settings,
        )
    except InternalAdminActionableEmailVerificationCompletionError as err:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=err.detail) from err
    except InternalAdminNotFoundError as err:
        await invalidate_stale_session(
            request=request,
            response=response,
            session_store=session_store,
            settings=settings,
        )
        raise_invalid_session_http_error(err)
    except InternalAdminContractError as err:
        await invalidate_stale_session(
            request=request,
            response=response,
            session_store=session_store,
            settings=settings,
        )
        raise_invalid_session_http_error(err)
    except Exception as err:
        raise_bff_http_error(err)
