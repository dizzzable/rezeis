from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status

from app.api.dependencies import get_platform_policy_service, raise_bff_http_error
from app.schemas.platform_policy import PlatformPolicySchema
from app.services.internal_admin_client import InternalAdminNotFoundError
from app.services.platform_policy_service import PlatformPolicyService

router: APIRouter = APIRouter(prefix="/platform-policy")


@router.get("", response_model=PlatformPolicySchema)
async def get_platform_policy(
    service: Annotated[PlatformPolicyService, Depends(get_platform_policy_service)],
) -> PlatformPolicySchema:
    try:
        return await service.get_platform_policy()
    except InternalAdminNotFoundError as err:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Internal admin request failed",
        ) from err
    except Exception as err:
        raise_bff_http_error(err)
