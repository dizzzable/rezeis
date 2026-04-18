from collections.abc import AsyncIterator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import ORJSONResponse

from app.api.router import api_router
from app.api.dependencies import set_internal_admin_client_state, set_session_store_state
from app.core.config import Settings, get_settings


async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    set_internal_admin_client_state(app)
    set_session_store_state(app)
    try:
        yield
    finally:
        internal_admin_client = getattr(app.state, "internal_admin_client", None)
        redis_client = getattr(app.state, "redis_client", None)
        if internal_admin_client is not None:
            await internal_admin_client.close()
        if redis_client is not None:
            await redis_client.aclose()


def create_app(settings: Settings | None = None) -> FastAPI:
    runtime_settings = settings or get_settings()
    app = FastAPI(
        title=runtime_settings.app_name,
        version=runtime_settings.app_version,
        default_response_class=ORJSONResponse,
        lifespan=lifespan,
    )
    allowed_origins = runtime_settings.get_browser_allowed_origins()
    if len(allowed_origins) > 0:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=allowed_origins,
            allow_credentials=True,
            allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
            allow_headers=["Authorization", "Content-Type"],
        )
    app.include_router(api_router, prefix=runtime_settings.api_prefix)

    @app.get("/")
    async def get_root_status() -> dict[str, str]:
        return {"message": runtime_settings.app_name}

    return app


settings = get_settings()
app: FastAPI = create_app(settings)
