from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends

from app.api.dependencies import get_plans_service, raise_bff_http_error
from app.schemas.plans import PlanSchema
from app.services.plans_service import PlansService

router: APIRouter = APIRouter(prefix="/plans")


@router.get("", response_model=list[PlanSchema])
async def get_plans(
    service: Annotated[PlansService, Depends(get_plans_service)],
) -> list[PlanSchema]:
    try:
        return await service.get_plans()
    except Exception as err:
        raise_bff_http_error(err)
