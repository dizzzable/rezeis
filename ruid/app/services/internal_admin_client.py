from __future__ import annotations

from collections.abc import Mapping

import httpx

NON_ACTIONABLE_SNOOZE_DETAILS: frozenset[str] = frozenset(
    {
        "webAccount link prompt is not actionable",
        "webAccount must exist",
    }
)

NON_ACTIONABLE_PASSWORD_HANDOFF_DETAILS: frozenset[str] = frozenset(
    {
        "webAccount password handoff is not actionable",
        "webAccount must exist",
        "webAccount link prompt is not actionable",
    }
)

NON_ACTIONABLE_EMAIL_VERIFICATION_CHALLENGE_DETAILS: frozenset[str] = frozenset(
    {
        "webAccount must exist",
        "webAccount email is already verified",
        "webAccount email must exist",
    }
)

NON_ACTIONABLE_EMAIL_VERIFICATION_COMPLETION_DETAILS: frozenset[str] = frozenset(
    {
        "webAccount must exist",
        "webAccount email is already verified",
        "webAccount email must exist",
    }
)

ACTIONABLE_EMAIL_VERIFICATION_COMPLETION_DETAILS: frozenset[str] = frozenset(
    {
        "active email verification challenge not found",
        "invalid email verification code",
    }
)

ACTIONABLE_PASSWORD_HANDOFF_DETAILS: frozenset[str] = frozenset(
    {
        "webAccount login is already taken",
    }
)


class InternalAdminError(Exception):
    """Base error raised for internal admin client failures."""


class InternalAdminNotFoundError(InternalAdminError):
    """Raised when the internal admin service cannot resolve a resource."""


class InternalAdminTimeoutError(InternalAdminError):
    """Raised when the internal admin service does not respond in time."""


class InternalAdminNonActionablePromptError(InternalAdminError):
    """Raised when a web-account prompt write is rejected because it is no longer actionable."""


class InternalAdminUpstreamError(InternalAdminError):
    """Raised when the internal admin service fails unexpectedly."""


class InternalAdminActionableEmailVerificationCompletionError(InternalAdminError):
    """Raised when email-verification completion fails with a user-actionable domain error."""

    def __init__(self, detail: str) -> None:
        super().__init__(detail)
        self.detail = detail


class InternalAdminActionablePasswordHandoffError(InternalAdminError):
    """Raised when password handoff fails with a user-actionable domain error."""

    def __init__(self, detail: str) -> None:
        super().__init__(detail)
        self.detail = detail


class InternalAdminContractError(InternalAdminError):
    """Raised when the internal admin response violates the agreed contract."""


class InternalAdminClient:
    def __init__(
        self,
        *,
        client: httpx.AsyncClient,
    ) -> None:
        self._client = client

    @property
    def is_closed(self) -> bool:
        return self._client.is_closed

    async def close(self) -> None:
        await self._client.aclose()

    async def patch_json(
        self,
        path: str,
        params: Mapping[str, str] | None = None,
    ) -> object:
        return await self._request_json(method="PATCH", path=path, params=params)

    async def patch_web_account_password(
        self, *, user_id: str, login: str, password: str
    ) -> object:
        return await self._request_json(
            method="PATCH",
            path="/api/internal/user/session/web-account-password",
            body={"userId": user_id, "login": login, "password": password},
        )

    async def patch_web_account_email_verification_challenge(self, *, user_id: str) -> object:
        return await self._request_json(
            method="PATCH",
            path="/api/internal/user/session/web-account-email-verification-challenge",
            body={"userId": user_id},
        )

    async def patch_web_account_email_verification_completion(
        self,
        *,
        user_id: str,
        code: str,
    ) -> object:
        return await self._request_json(
            method="PATCH",
            path="/api/internal/user/session/web-account-email-verification-completion",
            body={"userId": user_id, "code": code},
        )

    async def get_json(
        self,
        path: str,
        params: Mapping[str, str] | None = None,
    ) -> object:
        return await self._request_json(method="GET", path=path, params=params)

    async def _request_json(
        self,
        *,
        method: str,
        path: str,
        params: Mapping[str, str] | None = None,
        body: object | None = None,
    ) -> object:
        request_kwargs: dict[str, object] = {"method": method, "url": path, "params": params}
        if body is not None:
            request_kwargs["json"] = body
        try:
            response = await self._client.request(**request_kwargs)
            response.raise_for_status()
        except httpx.TimeoutException as err:
            raise InternalAdminTimeoutError from err
        except httpx.HTTPStatusError as err:
            actionable_detail = self._get_actionable_domain_error_detail(
                path=path,
                response=err.response,
            )
            if actionable_detail is not None:
                if path == "/api/internal/user/session/web-account-password":
                    raise InternalAdminActionablePasswordHandoffError(actionable_detail) from err
                raise InternalAdminActionableEmailVerificationCompletionError(
                    actionable_detail
                ) from err
            if self._is_non_actionable_prompt_error(path=path, response=err.response):
                raise InternalAdminNonActionablePromptError from err
            if err.response.status_code == httpx.codes.NOT_FOUND:
                raise InternalAdminNotFoundError from err
            raise InternalAdminUpstreamError from err
        except httpx.HTTPError as err:
            raise InternalAdminUpstreamError from err
        try:
            return response.json()
        except ValueError as err:
            raise InternalAdminContractError from err

    def _is_non_actionable_prompt_error(self, *, path: str, response: httpx.Response) -> bool:
        if response.status_code != httpx.codes.BAD_REQUEST:
            return False
        error_message = self._get_error_message(response)
        if path == "/api/internal/user/session/web-account-link-prompt-snooze":
            return error_message in NON_ACTIONABLE_SNOOZE_DETAILS
        if path == "/api/internal/user/session/web-account-password":
            return error_message in NON_ACTIONABLE_PASSWORD_HANDOFF_DETAILS
        if path == "/api/internal/user/session/web-account-email-verification-challenge":
            return error_message in NON_ACTIONABLE_EMAIL_VERIFICATION_CHALLENGE_DETAILS
        if path == "/api/internal/user/session/web-account-email-verification-completion":
            return error_message in NON_ACTIONABLE_EMAIL_VERIFICATION_COMPLETION_DETAILS
        return False

    def _get_actionable_domain_error_detail(
        self,
        *,
        path: str,
        response: httpx.Response,
    ) -> str | None:
        if response.status_code != httpx.codes.BAD_REQUEST:
            return None
        error_message = self._get_error_message(response)
        if path == "/api/internal/user/session/web-account-password":
            return error_message if error_message in ACTIONABLE_PASSWORD_HANDOFF_DETAILS else None
        if path == "/api/internal/user/session/web-account-email-verification-completion":
            return (
                error_message
                if error_message in ACTIONABLE_EMAIL_VERIFICATION_COMPLETION_DETAILS
                else None
            )
        return None

    def _get_error_message(self, response: httpx.Response) -> str | None:
        try:
            payload = response.json()
        except ValueError:
            return None
        if not isinstance(payload, dict):
            return None
        message = payload.get("message")
        if isinstance(message, str):
            return message
        if isinstance(message, list) and len(message) == 1 and isinstance(message[0], str):
            return message[0]
        detail = payload.get("detail")
        if not isinstance(detail, str):
            return None
        return detail


def build_internal_admin_client(
    *,
    base_url: str,
    internal_api_key: str,
    transport: httpx.AsyncBaseTransport | None = None,
) -> InternalAdminClient:
    http_client = httpx.AsyncClient(
        base_url=base_url,
        headers={"x-internal-api-key": internal_api_key},
        timeout=10.0,
        transport=transport,
    )
    return InternalAdminClient(client=http_client)
