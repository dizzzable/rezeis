-- «Автоплатежи одобрены провайдером» for ЮKassa (19.09.2026).
--
-- The switch is the gateway's `settings.savePaymentMethod`. Until this release
-- an absent key read as ON, and the settings dialog showed an unset switch as
-- ON and posted it back as `true` on every save, so a stored ON says nothing
-- about approval. From now on an absent key reads as OFF
-- (`gateway-autopay.util.ts`): a live ЮKassa shop charges saved methods only
-- after its manager approves autopayments.
--
-- The owner's rule: after the update the switch is ON where customers already
-- hold saved ЮKassa methods and OFF everywhere else. A saved method exists only
-- after ЮKassa answered `payment_method.saved = true`, which a shop without
-- approval never gets, so an active one proves the approval. Demo methods
-- (`demo_pm_…`) prove nothing. An operator who switched it OFF keeps it OFF:
-- that is the one value the old dialog never wrote by itself. It is read the
-- way `readBooleanSetting` reads it. A replay writes the same value again.
--
-- One statement over one row (`type` is unique): no lock bound is needed.
UPDATE "payment_gateways" AS g
SET "settings" = g."settings" || jsonb_build_object(
      'savePaymentMethod',
      EXISTS (
        SELECT 1
        FROM "saved_payment_methods" AS m
        WHERE m."gateway_type" = 'YOOKASSA'
          AND m."is_active"
          AND m."provider_method_id" <> ''
          AND m."provider_method_id" NOT LIKE 'demo\_pm\_%'
      )
    ),
    "updated_at" = NOW()
WHERE g."type" = 'YOOKASSA'
  AND jsonb_typeof(g."settings") = 'object'
  AND NOT COALESCE(
    CASE jsonb_typeof(g."settings" -> 'savePaymentMethod')
      WHEN 'boolean' THEN g."settings" -> 'savePaymentMethod' = 'false'::jsonb
      WHEN 'string' THEN lower(btrim(g."settings" ->> 'savePaymentMethod')) IN ('false', '0', 'no')
      WHEN 'number' THEN (g."settings" ->> 'savePaymentMethod')::numeric = 0
      ELSE false
    END,
    false
  );
