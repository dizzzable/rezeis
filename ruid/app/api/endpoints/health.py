from collections.abc import Mapping

from fastapi import APIRouter, status

router: APIRouter = APIRouter(prefix="/health")


@router.get("", status_code=status.HTTP_200_OK)
async def get_health_status() -> Mapping[str, str]:
    return {"status": "ok", "service": "ruid-user-service"}
