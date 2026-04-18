from app.core.config import Settings


def test_settings_load_aliases_from_environment(monkeypatch) -> None:
    monkeypatch.setenv("REZEIS_HOST", "rezeis-admin-api")
    monkeypatch.setenv("REZEIS_PORT", "3000")
    monkeypatch.delenv("REZEIS_BASE_URL", raising=False)
    monkeypatch.setenv("REZEIS_ADMIN_INTERNAL_API_KEY", "secret")
    monkeypatch.setenv("RUID_PUBLIC_WEB_URL", "https://user.example.com")
    monkeypatch.setenv(
        "RUID_BROWSER_ALLOWED_ORIGINS",
        "https://admin.example.com/app, https://staging.example.com",
    )
    monkeypatch.setenv("BOT_TOKEN", "telegram-token")
    monkeypatch.setenv("BOT_SECRET_TOKEN", "telegram-secret")
    monkeypatch.setenv("BOT_SUPPORT_USERNAME", "support")
    monkeypatch.setenv("BOT_MINI_APP", "https://user.example.com/")
    monkeypatch.setenv("TELEGRAM_AUTH_MAX_AGE_SECONDS", "120")
    monkeypatch.setenv("RUID_SESSION_COOKIE_NAME", "custom_session")
    monkeypatch.setenv("RUID_SESSION_TTL_SECONDS", "3600")
    monkeypatch.setenv("RUID_SESSION_COOKIE_SECURE", "true")
    monkeypatch.setenv("RUID_SESSION_COOKIE_DOMAIN", ".example.com")
    monkeypatch.setenv("RUID_SESSION_COOKIE_PATH", "/app")
    monkeypatch.setenv("RUID_SESSION_COOKIE_SAMESITE", "strict")
    monkeypatch.setenv("RUID_SESSION_KEY_PREFIX", "custom:session")
    monkeypatch.setenv("RUID_BOOTSTRAP_PROOF_KEY_SUFFIX", "bootstrap")

    settings = Settings()

    actual_url = settings.get_rezeis_base_url()

    assert actual_url == "http://rezeis-admin-api:3000"
    assert settings.rezeis_internal_api_key == "secret"
    assert settings.get_browser_allowed_origins() == [
        "https://user.example.com",
        "https://admin.example.com",
        "https://staging.example.com",
    ]
    assert settings.telegram_bot_token == "telegram-token"
    assert settings.telegram_bot_secret_token == "telegram-secret"
    assert settings.telegram_support_username == "support"
    assert settings.telegram_mini_app_url == "https://user.example.com/"
    assert settings.telegram_auth_max_age_seconds == 120
    assert settings.ruid_session_cookie_name == "custom_session"
    assert settings.ruid_session_ttl_seconds == 3600
    assert settings.ruid_session_cookie_secure is True
    assert settings.ruid_session_cookie_domain == ".example.com"
    assert settings.ruid_session_cookie_path == "/app"
    assert settings.ruid_session_cookie_samesite == "strict"
    assert settings.ruid_session_key_prefix == "custom:session"
    assert settings.ruid_bootstrap_proof_key_suffix == "bootstrap"


def test_settings_prefer_explicit_rezeis_base_url(monkeypatch) -> None:
    monkeypatch.setenv("REZEIS_BASE_URL", "https://admin.example.com/")
    monkeypatch.setenv("REZEIS_HOST", "rezeis-admin-api")
    monkeypatch.setenv("REZEIS_PORT", "3000")
    monkeypatch.setenv("REZEIS_ADMIN_INTERNAL_API_KEY", "secret")

    settings = Settings()

    assert settings.get_rezeis_base_url() == "https://admin.example.com"


def test_settings_reject_unknown_browser_origin(monkeypatch) -> None:
    monkeypatch.setenv("REZEIS_ADMIN_INTERNAL_API_KEY", "secret")
    monkeypatch.setenv("RUID_PUBLIC_WEB_URL", "https://user.example.com/app")

    settings = Settings()

    assert settings.is_allowed_browser_origin("https://user.example.com") is True
    assert settings.is_allowed_browser_origin("https://attacker.example.com") is False
