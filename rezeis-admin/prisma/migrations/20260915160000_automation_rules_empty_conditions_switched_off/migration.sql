-- Switch off the event and schedule rules whose conditions were saved as `{}`.
--
-- Until this release the evaluator read `{}` as a malformed expression and
-- answered false, so such a rule was SKIPPED "conditions did not match" on every
-- event and every tick: it never ran an action. From this release `{}` means "no
-- conditions" — which is what the SPA has always shown for it — so an ENABLED
-- rule carrying it would start acting the moment the new image boots: a ban
-- cascade, a blocked address, an outbound webhook, a pop-up, all from a rule
-- nobody has ever seen run.
--
-- So it is switched off instead, and one audit row per rule says so where an
-- operator looks («Журнал аудита»): the rule's id and name in the target columns,
-- the reason in the payload. Nothing that worked is lost — with `{}` the rule
-- never ran. MANUAL rules are left alone: the switch does not govern a manual
-- run, and a manual run of one still checks its conditions the new way.
--
-- One statement, so the switch and its audit rows commit together or not at
-- all. Replaying it is a no-op: a rule it switched off no longer matches.
-- `admin_audit_log.id` has no database default (Prisma generates a cuid), so the
-- row gets a UUID — core `gen_random_uuid()` since PostgreSQL 13.
WITH "switched_off" AS (
  UPDATE "automation_rules"
  SET "is_enabled" = false,
      "updated_at" = CURRENT_TIMESTAMP
  WHERE "is_enabled" = true
    AND "trigger_kind" IN ('REALTIME'::"AutomationTriggerKind", 'CRON'::"AutomationTriggerKind")
    AND "conditions" = '{}'::jsonb
  RETURNING "id", "name", "trigger_kind", "trigger_spec"
)
INSERT INTO "admin_audit_log" ("id", "action", "admin_user_id", "metadata", "created_at")
SELECT
  gen_random_uuid()::text,
  'automations.rule_switched_off_on_upgrade',
  NULL,
  jsonb_build_object(
    'targetType', 'automation_rule',
    'targetId', "switched_off"."id",
    'ruleName', "switched_off"."name",
    'triggerKind', "switched_off"."trigger_kind"::text,
    'triggerSpec', "switched_off"."trigger_spec",
    'migration', '20260915160000_automation_rules_empty_conditions_switched_off',
    'reason',
    'Правило выключено при обновлении панели. Его условия были сохранены пустыми — {}. '
      || 'До обновления такие условия не пропускали ни одного срабатывания, и с ними правило '
      || 'не выполнилось ни разу; после обновления {} означает «без условий», и правило начало '
      || 'бы действовать на каждое событие или по расписанию. Проверьте его условия и действия '
      || 'и включите правило снова, если оно должно работать.',
    'reasonEn',
    'Switched off by a panel update. Its conditions were saved empty — {}. Before the update '
      || 'such conditions let no run through, so with them the rule never acted; after it {} '
      || 'means "no conditions", and the rule would start acting on every event or tick. Check '
      || 'its conditions and actions, then switch it back on if it should run.'
  ),
  CURRENT_TIMESTAMP
FROM "switched_off";
