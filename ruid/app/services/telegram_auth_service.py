from __future__ import annotations

import hashlib
import hmac
import json
from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qsl

from pydantic import ValidationError

from app.schemas.telegram_auth import TelegramInitDataSchema, TelegramUserSchema


class TelegramAuthError(Exception):
    """Base error raised for Telegram Mini App authentication failures."""


class InvalidTelegramInitDataError(TelegramAuthError):
    """Raised when Telegram init data is malformed or has an invalid signature."""


class ExpiredTelegramInitDataError(TelegramAuthError):
    """Raised when Telegram init data is too old to trust."""


class ReplayTelegramInitDataError(TelegramAuthError):
    """Raised when Telegram init data was already exchanged for a session."""


class TelegramAuthService:
    def __init__(self, *, bot_token: str, auth_max_age_seconds: int) -> None:
        self._bot_token = bot_token
        self._auth_max_age_seconds = auth_max_age_seconds

    def validate_init_data(self, raw_init_data: str) -> TelegramInitDataSchema:
        parsed_values = self._parse_init_data(raw_init_data)
        received_hash = parsed_values.get("hash")
        if received_hash is None:
            raise InvalidTelegramInitDataError("Telegram init data hash is missing.")
        expected_hash = self._build_expected_hash(parsed_values)
        if not hmac.compare_digest(received_hash, expected_hash):
            raise InvalidTelegramInitDataError("Telegram init data signature is invalid.")
        auth_date = self._read_auth_date(parsed_values)
        self._validate_auth_date(auth_date)
        user = self._read_user(parsed_values)
        try:
            return TelegramInitDataSchema.model_validate(
                {
                    "rawInitData": raw_init_data,
                    "telegramId": str(user.id),
                    "authDate": auth_date,
                    "user": user.model_dump(mode="json", by_alias=True),
                },
            )
        except ValidationError as err:
            raise InvalidTelegramInitDataError("Telegram init data payload is invalid.") from err

    def _parse_init_data(self, raw_init_data: str) -> dict[str, str]:
        try:
            parsed_pairs = parse_qsl(
                raw_init_data,
                keep_blank_values=True,
                strict_parsing=True,
            )
        except ValueError as err:
            raise InvalidTelegramInitDataError("Telegram init data is malformed.") from err
        if len(parsed_pairs) == 0:
            raise InvalidTelegramInitDataError("Telegram init data is missing.")
        return dict(parsed_pairs)

    def _build_expected_hash(self, parsed_values: dict[str, str]) -> str:
        data_check_string = "\n".join(
            f"{key}={value}" for key, value in sorted(parsed_values.items()) if key != "hash"
        )
        secret_key = hmac.new(
            b"WebAppData",
            self._bot_token.encode("utf-8"),
            hashlib.sha256,
        ).digest()
        return hmac.new(
            secret_key,
            data_check_string.encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()

    def _read_auth_date(self, parsed_values: dict[str, str]) -> datetime:
        auth_date_value = parsed_values.get("auth_date")
        if auth_date_value is None:
            raise InvalidTelegramInitDataError("Telegram init data auth_date is missing.")
        try:
            auth_date_timestamp = int(auth_date_value)
        except ValueError as err:
            raise InvalidTelegramInitDataError("Telegram init data auth_date is invalid.") from err
        return datetime.fromtimestamp(auth_date_timestamp, tz=UTC)

    def _validate_auth_date(self, auth_date: datetime) -> None:
        now = datetime.now(tz=UTC)
        max_age = timedelta(seconds=self._auth_max_age_seconds)
        if auth_date > now + timedelta(seconds=30):
            raise ExpiredTelegramInitDataError("Telegram init data auth_date is in the future.")
        if now - auth_date > max_age:
            raise ExpiredTelegramInitDataError("Telegram init data auth_date is too old.")

    def _read_user(self, parsed_values: dict[str, str]) -> TelegramUserSchema:
        user_value = parsed_values.get("user")
        if user_value is None:
            raise InvalidTelegramInitDataError("Telegram init data user payload is missing.")
        try:
            parsed_user = json.loads(user_value)
        except json.JSONDecodeError as err:
            raise InvalidTelegramInitDataError(
                "Telegram init data user payload is invalid."
            ) from err
        try:
            return TelegramUserSchema.model_validate(parsed_user)
        except ValidationError as err:
            raise InvalidTelegramInitDataError(
                "Telegram init data user payload is invalid."
            ) from err
