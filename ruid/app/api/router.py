from fastapi import APIRouter

from app.api.endpoints.auth import router as auth_router
from app.api.endpoints.health import router as health_router
from app.api.endpoints.platform_policy import router as platform_policy_router
from app.api.endpoints.plans import router as plans_router
from app.api.endpoints.session import router as session_router
from app.api.endpoints.subscription import router as subscription_router

api_router: APIRouter = APIRouter()
api_router.include_router(health_router, tags=["health"])
api_router.include_router(auth_router, tags=["auth"])
api_router.include_router(session_router, tags=["session"])
api_router.include_router(plans_router, tags=["plans"])
api_router.include_router(platform_policy_router, tags=["platform-policy"])
api_router.include_router(subscription_router, tags=["subscription"])
