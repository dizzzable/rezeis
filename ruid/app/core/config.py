from functools import lru_cache
from urllib.parse import urlsplit

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


DEFAULT_TELEGRAM_AUTH_MAX_AGE_SECONDS = 300
DEFAULT_RUID_SESSION_TTL_SECONDS = 604800
DEFAULT_RUID_BOOTSTRAP_PROOF_KEY_SUFFIX = "bootstrap-proof"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    app_name: str = Field(default="ruid-user-service")
    app_version: str = Field(default="0.1.0")
    api_prefix: str = Field(default="/api/v1")
    environment: str = Field(default="development")
    redis_url: str = Field(default="redis://localhost:6379/0")
    rezeis_base_url: str | None = Field(default=None, validation_alias="REZEIS_BASE_URL")
    rezeis_host: str = Field(default="rezeis-admin-api", validation_alias="REZEIS_HOST")
    rezeis_port: int = Field(default=3000, validation_alias="REZEIS_PORT")
    rezeis_internal_api_key: str = Field(
        validation_alias=AliasChoices("REZEIS_ADMIN_INTERNAL_API_KEY", "REZEIS_INTERNAL_API_KEY"),
    )
    ruid_public_web_url: str | None = Field(default=None, validation_alias="RUID_PUBLIC_WEB_URL")
    ruid_browser_allowed_origins: str = Field(
        default="",
        validation_alias="RUID_BROWSER_ALLOWED_ORIGINS",
    )
    telegram_bot_token: str | None = Field(
        default=None,
        validation_alias=AliasChoices("TELEGRAM_BOT_TOKEN", "BOT_TOKEN"),
    )
    telegram_bot_secret_token: str | None = Field(
        default=None,
        validation_alias=AliasChoices("TELEGRAM_BOT_SECRET_TOKEN", "BOT_SECRET_TOKEN"),
    )
    telegram_support_username: str | None = Field(
        default=None,
        validation_alias=AliasChoices("TELEGRAM_SUPPORT_USERNAME", "BOT_SUPPORT_USERNAME"),
    )
    telegram_mini_app_url: str | None = Field(
        default=None,
        validation_alias=AliasChoices("TELEGRAM_MINI_APP_URL", "BOT_MINI_APP"),
    )
    telegram_auth_max_age_seconds: int = Field(
        default=DEFAULT_TELEGRAM_AUTH_MAX_AGE_SECONDS,
        validation_alias="TELEGRAM_AUTH_MAX_AGE_SECONDS",
    )
    ruid_session_cookie_name: str = Field(
        default="ruid_session",
        validation_alias="RUID_SESSION_COOKIE_NAME",
    )
    ruid_session_ttl_seconds: int = Field(
        default=DEFAULT_RUID_SESSION_TTL_SECONDS,
        validation_alias="RUID_SESSION_TTL_SECONDS",
    )
    ruid_session_cookie_secure: bool = Field(
        default=True,
        validation_alias="RUID_SESSION_COOKIE_SECURE",
    )
    ruid_session_cookie_domain: str | None = Field(
        default=None,
        validation_alias="RUID_SESSION_COOKIE_DOMAIN",
    )
    ruid_session_cookie_path: str = Field(
        default="/",
        validation_alias="RUID_SESSION_COOKIE_PATH",
    )
    ruid_session_cookie_samesite: str = Field(
        default="lax",
        validation_alias="RUID_SESSION_COOKIE_SAMESITE",
    )
    ruid_session_key_prefix: str = Field(
        default="ruid:session",
        validation_alias="RUID_SESSION_KEY_PREFIX",
    )
    ruid_bootstrap_proof_key_suffix: str = Field(
        default=DEFAULT_RUID_BOOTSTRAP_PROOF_KEY_SUFFIX,
        validation_alias="RUID_BOOTSTRAP_PROOF_KEY_SUFFIX",
    )

    def get_rezeis_base_url(self) -> str:
        if self.rezeis_base_url is not None:
            return self.rezeis_base_url.rstrip("/")
        return f"http://{self.rezeis_host}:{self.rezeis_port}"

    def get_browser_allowed_origins(self) -> list[str]:
        configured_origins = [self.ruid_public_web_url, *self._parse_origin_list()]
        normalized_origins = [
            normalized_origin
            for configured_origin in configured_origins
            if configured_origin is not None
            for normalized_origin in [self._normalize_browser_origin(configured_origin)]
            if normalized_origin is not None
        ]
        return list(dict.fromkeys(normalized_origins))

    def is_allowed_browser_origin(self, origin: str) -> bool:
        normalized_origin = self._normalize_browser_origin(origin)
        if normalized_origin is None:
            return False
        return normalized_origin in self.get_browser_allowed_origins()

    def _parse_origin_list(self) -> list[str]:
        return [
            value.strip() for value in self.ruid_browser_allowed_origins.split(",") if value.strip()
        ]

    def _normalize_browser_origin(self, value: str) -> str | None:
        parsed_url = urlsplit(value)
        if parsed_url.scheme == "" or parsed_url.netloc == "":
            return None
        return f"{parsed_url.scheme}://{parsed_url.netloc}"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
