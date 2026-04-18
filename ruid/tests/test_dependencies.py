from __future__ import annotations

import pytest
from fastapi import HTTPException, Response
from starlette.requests import Request

from app.api.dependencies import (
    get_current_auth_session,
    get_telegram_auth_init_data,
    raise_bff_http_error,
    validate_browser_origin,
)
from app.core.config import Settings
from app.services.internal_admin_client import (
    InternalAdminContractError,
    InternalAdminNotFoundError,
    InternalAdminTimeoutError,
    InternalAdminUpstreamError,
)
from app.services.telegram_auth_service import (
    ExpiredTelegramInitDataError,
    InvalidTelegramInitDataError,
    ReplayTelegramInitDataError,
)
from tests.support import InMemorySessionStore, build_auth_session


def build_settings(**overrides: object) -> Settings:
    return Settings(rezeis_internal_api_key="secret", **overrides)


def build_request(
    *,
    headers: dict[str, str] | None = None,
    cookies: dict[str, str] | None = None,
) -> Request:
    raw_headers: list[tuple[bytes, bytes]] = [(b"host", b"testserver")]
    actual_headers = headers or {}
    for key, value in actual_headers.items():
        raw_headers.append((key.lower().encode("utf-8"), value.encode("utf-8")))
    if cookies is not None and len(cookies) > 0:
        cookie_header = "; ".join(f"{key}={value}" for key, value in cookies.items())
        raw_headers.append((b"cookie", cookie_header.encode("utf-8")))
    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": "/",
        "raw_path": b"/",
        "query_string": b"",
        "headers": raw_headers,
        "client": ("127.0.0.1", 123),
        "server": ("testserver", 80),
    }
    return Request(scope)


@pytest.mark.parametrize(
    ("authorization", "expected_detail"),
    [
        (None, "Missing Telegram Mini App authorization header."),
        ("Bearer abc", "Invalid Telegram Mini App authorization header."),
        ("tma", "Invalid Telegram Mini App authorization header."),
        ("tma ", "Invalid Telegram Mini App authorization header."),
    ],
)
def test_get_telegram_auth_init_data_rejects_missing_or_malformed_header(
    authorization: str | None,
    expected_detail: str,
) -> None:
    with pytest.raises(HTTPException) as actual_error:
        get_telegram_auth_init_data(authorization)

    assert actual_error.value.status_code == 401
    assert actual_error.value.detail == expected_detail


def test_get_telegram_auth_init_data_returns_raw_tma_value() -> None:
    actual_value = get_telegram_auth_init_data("tma signed-payload")

    assert actual_value == "signed-payload"


def test_validate_browser_origin_allows_configured_public_web_origin() -> None:
    request = build_request(headers={"origin": "https://miniapp.example.com"})
    settings = build_settings(ruid_public_web_url="https://miniapp.example.com/app")

    validate_browser_origin(request, settings)


def test_validate_browser_origin_allows_empty_origin_configuration() -> None:
    request = build_request()
    settings = build_settings()

    validate_browser_origin(request, settings)


def test_validate_browser_origin_rejects_missing_origin_when_allowed_origins_exist() -> None:
    request = build_request()
    settings = build_settings(ruid_public_web_url="https://miniapp.example.com/app")

    with pytest.raises(HTTPException) as actual_error:
        validate_browser_origin(request, settings)

    assert actual_error.value.status_code == 403
    assert actual_error.value.detail == "Browser origin header is required."


def test_validate_browser_origin_rejects_unknown_origin() -> None:
    request = build_request(headers={"origin": "https://attacker.example.com"})
    settings = build_settings(
        ruid_public_web_url="https://miniapp.example.com/app",
        ruid_browser_allowed_origins="https://staging.example.com",
    )

    with pytest.raises(HTTPException) as actual_error:
        validate_browser_origin(request, settings)

    assert actual_error.value.status_code == 403
    assert actual_error.value.detail == "Browser origin is not allowed."


@pytest.mark.asyncio
async def test_get_current_auth_session_rejects_missing_cookie() -> None:
    request = build_request()
    response = Response()
    session_store = InMemorySessionStore()
    settings = build_settings()

    with pytest.raises(HTTPException) as actual_error:
        await get_current_auth_session(request, response, session_store, settings)

    assert actual_error.value.status_code == 401
    assert actual_error.value.detail == "Authentication required."


@pytest.mark.asyncio
async def test_get_current_auth_session_rejects_missing_backing_session() -> None:
    request = build_request(cookies={"ruid_session": "missing-session"})
    response = Response()
    session_store = InMemorySessionStore()
    settings = build_settings()

    with pytest.raises(HTTPException) as actual_error:
        await get_current_auth_session(request, response, session_store, settings)

    assert actual_error.value.status_code == 401
    assert actual_error.value.detail == "Session is missing or expired."
    assert response.headers["set-cookie"].startswith("ruid_session=")
    assert "Max-Age=0" in response.headers["set-cookie"]


@pytest.mark.asyncio
async def test_get_current_auth_session_returns_valid_session() -> None:
    auth_session = build_auth_session(user_id="user-1")
    request = build_request(cookies={"ruid_session": "stored-session"})
    response = Response()
    session_store = InMemorySessionStore()
    session_store.sessions["stored-session"] = auth_session
    settings = build_settings()

    actual_session = await get_current_auth_session(request, response, session_store, settings)

    assert actual_session == auth_session
    assert "set-cookie" not in response.headers


@pytest.mark.parametrize(
    ("error", "expected_status", "expected_detail"),
    [
        (InternalAdminTimeoutError(), 504, "Internal admin request timed out"),
        (InternalAdminUpstreamError(), 502, "Internal admin request failed"),
        (
            InternalAdminContractError(),
            502,
            "Internal admin returned an invalid contract payload",
        ),
        (InternalAdminNotFoundError(), 404, "User not found"),
    ],
)
def test_raise_bff_http_error_maps_internal_admin_errors(
    error: Exception,
    expected_status: int,
    expected_detail: str,
) -> None:
    with pytest.raises(HTTPException) as actual_error:
        raise_bff_http_error(error)

    assert actual_error.value.status_code == expected_status
    assert actual_error.value.detail == expected_detail


@pytest.mark.parametrize(
    "error",
    [
        InvalidTelegramInitDataError("Telegram init data is malformed."),
        ExpiredTelegramInitDataError("Telegram init data auth_date is too old."),
        ReplayTelegramInitDataError("Telegram init data was already used to create a session."),
    ],
)
def test_raise_bff_http_error_maps_telegram_validation_errors(error: Exception) -> None:
    with pytest.raises(HTTPException) as actual_error:
        raise_bff_http_error(error)

    assert actual_error.value.status_code == 401
    assert actual_error.value.detail == str(error)
