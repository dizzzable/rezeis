-- Telegram Login can now use the OAuth2 / OpenID Connect flow
-- (oauth.telegram.org) in addition to the classic Login Widget. This flag
-- selects OIDC when the operator has configured a Client ID + Secret from
-- @BotFather; otherwise the widget (bot token + domain) is used.
ALTER TABLE "external_auth_provider_configs"
  ADD COLUMN "use_oidc" BOOLEAN NOT NULL DEFAULT false;
