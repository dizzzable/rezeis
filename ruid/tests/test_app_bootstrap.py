from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

import app.main as main_module
from app.core.config import Settings


class TrackingInternalAdminClient:
    def __init__(self) -> None:
        self.close_calls: int = 0
        self.is_closed: bool = False

    async def close(self) -> None:
        self.close_calls += 1
        self.is_closed = True


class TrackingRedisClient:
    def __init__(self) -> None:
        self.close_calls: int = 0
        self.is_closed: bool = False

    async def aclose(self) -> None:
        self.close_calls += 1
        self.is_closed = True


def build_runtime_settings() -> Settings:
    return Settings(
        app_name="ruid-test-service",
        rezeis_internal_api_key="secret",
        ruid_public_web_url="https://miniapp.example.com/app",
        ruid_browser_allowed_origins="https://admin.example.com/panel",
    )


def test_create_app_exposes_root_and_health_endpoints() -> None:
    test_app = main_module.create_app(build_runtime_settings())

    with TestClient(test_app) as client:
        root_response = client.get("/")
        health_response = client.get("/api/v1/health")

    assert root_response.status_code == 200
    assert root_response.json() == {"message": "ruid-test-service"}
    assert health_response.status_code == 200
    assert health_response.json() == {"status": "ok", "service": "ruid-user-service"}


def test_create_app_adds_credentialed_cors_headers_from_browser_origin_allowlist() -> None:
    test_app = main_module.create_app(build_runtime_settings())

    with TestClient(test_app) as client:
        public_origin_response = client.options(
            "/api/v1/health",
            headers={
                "Origin": "https://miniapp.example.com",
                "Access-Control-Request-Method": "GET",
            },
        )
        configured_origin_response = client.options(
            "/api/v1/health",
            headers={
                "Origin": "https://admin.example.com",
                "Access-Control-Request-Method": "GET",
            },
        )
        disallowed_origin_response = client.options(
            "/api/v1/health",
            headers={
                "Origin": "https://attacker.example.com",
                "Access-Control-Request-Method": "GET",
            },
        )

    assert public_origin_response.status_code == 200
    assert (
        public_origin_response.headers["access-control-allow-origin"]
        == "https://miniapp.example.com"
    )
    assert public_origin_response.headers["access-control-allow-credentials"] == "true"
    assert configured_origin_response.status_code == 200
    assert (
        configured_origin_response.headers["access-control-allow-origin"]
        == "https://admin.example.com"
    )
    assert configured_origin_response.headers["access-control-allow-credentials"] == "true"
    assert disallowed_origin_response.status_code == 400
    assert "access-control-allow-origin" not in disallowed_origin_response.headers


def test_lifespan_reuses_one_internal_admin_client_and_closes_resources_on_shutdown(
    monkeypatch,
) -> None:
    created_internal_admin_clients: list[TrackingInternalAdminClient] = []
    created_redis_clients: list[TrackingRedisClient] = []

    def fake_set_internal_admin_client_state(app: FastAPI) -> None:
        if hasattr(app.state, "internal_admin_client"):
            return
        internal_admin_client = TrackingInternalAdminClient()
        created_internal_admin_clients.append(internal_admin_client)
        app.state.internal_admin_client = internal_admin_client

    def fake_set_session_store_state(app: FastAPI) -> None:
        if hasattr(app.state, "session_store"):
            return
        redis_client = TrackingRedisClient()
        created_redis_clients.append(redis_client)
        app.state.redis_client = redis_client
        app.state.session_store = object()

    monkeypatch.setattr(
        main_module, "set_internal_admin_client_state", fake_set_internal_admin_client_state
    )
    monkeypatch.setattr(main_module, "set_session_store_state", fake_set_session_store_state)
    test_app = main_module.create_app(build_runtime_settings())

    with TestClient(test_app) as client:
        first_response = client.get("/api/v1/health")
        second_response = client.get("/api/v1/health")
        internal_admin_client = test_app.state.internal_admin_client
        redis_client = test_app.state.redis_client

    assert first_response.status_code == 200
    assert second_response.status_code == 200
    assert len(created_internal_admin_clients) == 1
    assert len(created_redis_clients) == 1
    assert internal_admin_client is created_internal_admin_clients[0]
    assert redis_client is created_redis_clients[0]
    assert created_internal_admin_clients[0].close_calls == 1
    assert created_internal_admin_clients[0].is_closed is True
    assert created_redis_clients[0].close_calls == 1
    assert created_redis_clients[0].is_closed is True
