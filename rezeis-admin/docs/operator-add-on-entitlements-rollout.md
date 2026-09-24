# Operator runbook: subscription add-on entitlements (defaults, rollout, rollback)

This runbook covers the durable add-on entitlement model: subscription terms,
the effective projection and add-on entitlements with an end date. Every stage is
a **deployment-time environment flag**. The flags cannot be edited in the panel,
for two reasons: entering the model is one-way for each subscription, and the web
and worker processes must change at the same moment.

## 0. The flags, their defaults, and how to override them

The defaults live in one table in the code:
`ADD_ON_ROLLOUT_FLAG_DEFAULTS` in
`src/modules/add-on-entitlements/add-on-rollout.config.ts`. A variable that is not
set takes the default from that table.

| Stage | Variable | Default | Why |
|---|---|---|---|
| 1 | `ADDON_ENTITLEMENT_SHADOW` | **ON** | Owner's decision, 24.09.2026. |
| 2 | `ADDON_ENTITLEMENT_DIRECT_PURCHASE` | **ON** | Owner's decision, 24.09.2026. |
| 3 | `ADDON_PROJECTION_SYNC` | OFF | See stage 3: it would break the upgrade's expiry. |
| 4 | `ADDON_RESET_EXPIRY_{DAY,WEEK,MONTH,MONTH_ROLLING}` | OFF | See stage 4: no parity with Remnawave 3.x yet. |
| 5 | `ADDON_RENEWAL_ADDONS` | OFF | Owner's decision. |
| 6 | `ADDON_DEVICE_CLEANUP_AUTO` | **ON** | Owner's decision, 24.09.2026. |

**Stages 1, 2 and 6 are ON by default from this release.** An install that sets
none of these variables gets the table above as soon as it runs the new
version: the worker starts bringing every subscription into the model at boot
(see [The background cutover](#the-background-cutover)), add-ons bought from
then on end with the subscription, and devices over the limit are removed when
a device add-on ends. An install that already sets a variable in `.env` keeps
its own value.

**Switching a stage off, or on, on one install.** Put the variable in `.env`,
then run `docker compose up -d`. Both containers (API and worker) read `.env`,
and the flags are read on every call, so the change takes effect right after
the restart. To keep the durable model off entirely:

```
ADDON_ENTITLEMENT_SHADOW=false
ADDON_ENTITLEMENT_DIRECT_PURCHASE=false
ADDON_DEVICE_CLEANUP_AUTO=false
```

What that does, and what it does not undo once the model has run, is in
[Rollback](#rollback). The parser accepts these values:

- `true`, `1`, `on` or `yes` turns the stage **ON**, and `false`, `0`, `off` or
  `no` turns it **OFF**. Case and surrounding spaces do not matter, so `False`,
  ` 0 ` and `Off` all mean OFF.
- An **explicit OFF beats an ON default.** This is how one install stays off:
  set `ADDON_ENTITLEMENT_SHADOW=false` (or `off`, `no`, `0`).
- An empty or unset variable takes the default.
- Anything else (`enabled`, `disabled`, a typo) also takes the default, and the
  log shows one warning per value: `ADDON_…="disabled" is not a recognised value
  …`. `disabled` does **not** turn a stage off.

### What a flag decides, and what it does not

A flag decides **who enters the model** and **whether new purchases are
recorded as entitlements**. Once a subscription has a term, no flag decides how
that term is treated:

- The boundary sweep expires sold add-ons, aligns terms and activates renewal
  terms whatever the flags say.
- Plan migration rotates a term whenever one is ACTIVE.
- The shared plan-change rotation and tail alignment also read no flag.
- A paid renewal appends its term, and a paid upgrade starts one, whenever the
  subscription has an ACTIVE term. See
  [Payments on a subscription in the model](#payments-on-a-subscription-in-the-model).

This is what makes rollback safe. See [Rollback](#rollback).

## 1. Stage 1, `ADDON_ENTITLEMENT_SHADOW`: subscriptions enter the model

With stage 1 ON:

- **The background cutover** gives every subscription that is not DELETED its
  first term (generation 1, ACTIVE) and a SHADOW projection. Both are minted
  from the subscription's own limit columns, so the projection equals the legacy
  limits by construction. It makes no Remnawave call.
- **A purchase creates its subscription in the model.** NEW, ADDITIONAL and a
  paid trial get their first term and SHADOW projection in the payment's own
  transaction, so an add-on bought a minute later already gets an end date.
- **A payment brings in a subscription the cutover has not reached yet.** An
  add-on purchase (stage 2 on as well), a paid renewal and a paid upgrade first
  give it its first term, then do their own work on it. A renewal carrying paid
  add-on lines (stage 5) brings it in whatever stage 1 says: those add-ons have
  nowhere else to live.

### The background cutover

You do not need to run anything. The worker runs it, from the first boot of the
version that turned stage 1 on by default.

- **When.** Every 5 minutes, on the process that runs schedules (the worker). The
  first pass starts at boot, and boot does not wait for it. When nothing is left,
  a pass is one short query. It keeps running so that subscriptions created later
  are picked up. On an empty database (a fresh install) a pass finds nothing and
  writes nothing.
- **How much per pass.**
  - It reads pages of 200 subscriptions and uses **one transaction per
    subscription**.
  - A pass stops at 5,000 subscriptions or after 3 minutes, whichever comes
    first, with a 100 ms pause between pages. The next pass continues.
  - Measured on PostgreSQL 17: about 15 ms per subscription (8,572 in 125 s), so a
    5,000-row pass takes a little over a minute, and 100,000 subscriptions are in
    the model within about two hours.
  - Once everything is in the model, a pass over 100,000 subscriptions costs about
    30 ms, and the hourly drift sweep about 0.2 s.
- **One runner.** Each pass is a BullMQ job with a fixed id
  (`add-on-entitlement-cutover-tick`). While one pass is queued or running, no
  other pass can start, even with several workers or during a blue/green switch.
- **Safe to interrupt.** A deploy, a crash or a SIGKILL loses at most the row in
  flight, which is rolled back whole. A subscription that already has a term is
  never touched again, so the next pass carries on without any saved position.
- **Safe beside payments.** Each subscription is brought in under its row lock.
  Every payment path that writes terms takes the same lock first.
- **A row that fails.**
  - A lock conflict (deadlock or serialization) is retried in place, then left
    for the next pass without an incident.
  - Any other error opens **one** incident for that subscription: kind
    `RECONCILIATION_REQUIRED`, summary code `CUTOVER_FAILED`. The error is in the
    incident's metadata. While the incident is OPEN, the subscription is left out
    of every pass.
  - To retry it, fix the cause, then open the subscription in the inspector on
    the entitlements tab and press **«Принять»** on the incident. The next pass
    tries the subscription again. If it fails again, a new incident opens.

### How the first term is shaped

- **Window.** The term runs from `createdAt` to `expiresAt`.
  - A subscription that had **already lapsed** when it was created (typical of an
    import, where `expiresAt <= createdAt`) gets a one-second window that ends at
    `expiresAt`. It is counted as AMBIGUOUS (`NON_POSITIVE_TERM_WINDOW`). A paid
    renewal then appends its own term starting from the payment.
  - Only a **lifetime** subscription (`expiresAt` empty) gets a term with no end.
- **Limits.** The term's base limits are the current columns. Legacy add-ons
  bought before the switch are already in those columns, so they are
  **grandfathered**: customers notice nothing, and only purchases made after
  stage 2 get an end date.

### Where to watch it

- **The metrics endpoint.** `GET /admin/add-on-entitlements/metrics` has a
  `cutover` block with four counts:
  - `eligible`: subscriptions that are not DELETED;
  - `inModel`: those that already have a term;
  - `remaining`: those that do not yet;
  - `needAttention`: those held out by an OPEN `CUTOVER_FAILED` incident.
- **The «Дополнительные опции» page, entitlements tab.** It loads that endpoint
  but does not show the `cutover` block yet. What it shows today is the count of
  SHADOW projections (one per subscription brought in) and open incidents by
  kind (`RECONCILIATION_REQUIRED` includes the cutover failures). Each incident
  opens in the subscription inspector.
- **The worker log.** Each pass that did anything logs a line such as
  `Cutover applied: created N (… matched, … ambiguous, 0 shadow mismatch(es)) …`.

### Go/no-go and the manual script

- **Go/no-go.** Watch the `shadow mismatch(es)` count in the log. It must stay 0.
  A mismatch means a projection differs from the columns it was minted from,
  which is a defect.
- **The manual script** runs the same loop:

  ```
  node --require ts-node/register scripts/add-on-entitlement-cutover.ts          # dry run: classify only
  node --require ts-node/register scripts/add-on-entitlement-cutover.ts --apply  # write
    --batch <n>        page size (default 200)
    --max <n>          stop after n subscriptions
    --only <id,id,...> only these subscriptions (for example after accepting their incidents)
  ```

### Payments on a subscription in the model

Decided by the term row, whatever the flags say.

- **Renewal.** Appends a SCHEDULED term on the plan it renews, starting where
  the last term ends — after first aligning that term with the subscription's
  expiry, so days a writer left to the hourly drift sweep (referral days, bulk
  «Продлить подписку») are not lost to the add-ons sold "until the end".
  - A **lifetime** subscription (`expiresAt` empty) is not renewed at all (the
    owner, 24.09.2026). Every checkout refuses it (`SUBSCRIPTION_IS_LIFETIME`),
    and a payment that arrives anyway changes nothing, in the model or not:
    its open-ended term stays open, nothing is appended, and its add-ons with
    no end keep none. The payment is settled, and the operator gets «Платёж
    получен, нужна проверка» asking for the refund (code
    `LIFETIME_RENEWAL_NOT_APPLIED`). A renewal that meets an open-ended tail on
    a subscription that does have a date — the expiry moved before a queued
    lifetime term, see «Shortening across a queued SCHEDULED term» — fails
    closed with `RENEWAL_AFTER_OPEN_ENDED_TERM` and stays unfulfilled.
- **Renewal priced before a plan change** (every subscription, in the model or
  not). The checkout was drafted, then the plan changed: a paid upgrade,
  «Назначить план» or a bulk assignment. The renewal keeps the plan the
  subscription is on now, and its money is converted into days of that plan by
  its dearest day. The payment card says so and why.
  - One whose money buys no day renews nothing: status, expiry and traffic stay
    as they are, and the card asks for a refund.
  - A plan **migration** since the draft is different: the renewal keeps its
    whole period on the current plan (owner's decision of 15.09.2026).
- **Paid upgrade.** Starts an ACTIVE term on the new plan at the payment.
  - What the subscription held above the old plan carries onto the new one: an
    operator's raise, a legacy add-on folded into the first term. A 3-device
    plan with a legacy +2, upgraded to a 10-device plan, gets 12. A bonus that
    its writer also recorded in the plan snapshot (promo, points, prize traffic)
    reads as the plan's own value and does not carry.
  - Live add-ons keep their own end dates, never later than the new end, and
    count on the new term (audit reason `UPGRADE_KEPT_OWN_END`).
  - A queued renewal term that carries paid add-ons survives: it is re-based
    onto the new plan and runs after the new term, and its days are already in
    the new expiry. When the upgrade ends before that period would begin, its
    add-ons cannot be delivered; the card «⏭ Тариф улучшен, а оплаченный
    следующий период начнётся после конца подписки» asks the operator to decide
    on a refund. A queued term with nothing bought for it is cancelled.

## 2. Stage 2, `ADDON_ENTITLEMENT_DIRECT_PURCHASE`: purchases are recorded

- **What it does.** A completed add-on purchase creates an immutable
  `AddOnEntitlement` with an end date. It then recomputes the projection and
  mirrors it into the legacy limit columns, so the ordinary profile sync pushes
  the ledger-backed limits.
  - For an ACTIVE subscription and for a LIMITED one (out of traffic is when
    "+50 GB" is bought).
  - The term is first aligned with the subscription's expiry, so bonus days or
    an operator's edit do not send the purchase to the legacy increment. The
    checkout aligns it too before it decides what it can sell.
  - A draft made by the checkout before this version is recorded "until the end
    of the subscription".
  - On an unlimited baseline the purchase is recorded as a no-op.
  - With no active term (stage 1 off, and a subscription not yet in the model),
    the purchase falls back to the legacy increment.
- **What the customer is told.** The add-on offer says, per add-on, whether
  buying it now is recorded with an end (`eligibility.dated`), by the same
  gates. The cabinet shows «Действует до …» on the card and on «Подтверждение»
  only then. With stage 2 OFF, for a subscription the purchase cannot bring
  into the model, or for a lifetime subscription, the purchase is permanent and
  no date is shown.
- **Check.** One paid add-on produces one ACTIVE entitlement, and the mirrored
  limits equal base plus add-on. A webhook replay creates nothing new.

## 3. Stage 3, `ADDON_PROJECTION_SYNC`: keep it OFF

**Keep stage 3 OFF on every install.** The versioned write sends only the
limits, tag, strategy and squads, followed by a read-back. It does **not** send
`expireAt`, `status`, the description or the contacts. On a paid upgrade that
creates a versioned job, the Remnawave expiry would therefore never move, and the
customer would be cut off at the old date.

Stages 1 and 2 do not need stage 3. The legacy push already sends the mirrored
columns in full.

## 4. Stage 4, reset expiry per strategy: keep it OFF until parity is shown

Do not turn on a strategy until parity has been shown against **every Remnawave
line this panel serves: 3.2.x, 3.3.x and 3.4.x**. The panel refuses 2.x
outright, so the old 2.7.4 and 2.8.0 criterion no longer applies. Parity needs
three things:

1. A harness against each of those lines.
2. Proof that the panel's own reset job fires at the same instant as our UTC
   epoch math, including the panel's timezone and week start. The math is:
   - `utcDayStart`;
   - `utcWeekStart`, where the week starts on Monday;
   - `utcMonthStart`;
   - for MONTH_ROLLING, the anniversary of the panel profile's `createdAt`.
3. A probe showing that a paid epoch ends exactly when the panel zeroes usage.

Then turn on one strategy at a time: `ADDON_RESET_EXPIRY_DAY`, `_WEEK`, `_MONTH`
or `_MONTH_ROLLING`. Turning a strategy off stops new `UNTIL_NEXT_RESET` sales.
Epochs that already exist are not deleted.

## 5. Stage 5, `ADDON_RENEWAL_ADDONS`: OFF (owner's decision)

This stage adds add-on lines to the renewal checkout. Fulfilling such a renewal
creates the SCHEDULED renewal term together with its PENDING entitlements, in
one transaction. The cabinet shows the step only when the platform policy's
`renewalAddOns` capability is on.

## 6. Stage 6, `ADDON_DEVICE_CLEANUP_AUTO`: automatic device reduction (target ON)

When a device add-on ends, the desired device limit drops. The panel then refuses
**new** registrations over the limit. What happens to the devices already
registered depends on stage 6:

- **ON.** The deterministic reduction plan is executed automatically. It deletes
  the newest registrations first, and it refuses to delete a recently seen device
  while keeping a dormant one.
- **OFF.**
  - Plans wait for an operator's approval on the entitlements tab (the approve
    button on the device plan).
  - While a plan waits, the five-minute sweep **parks** that subscription and does
    not re-plan it every tick. An hourly re-drive (at :23) looks at parked rows,
    oldest first and at most 100 per run. That re-drive is what notices a device
    list the customer reduced on their own.

**When the planner refuses.** This happens for a dormancy conflict, or when a
stored 2.x identity cannot be trusted on a 3.x panel. The planner raises **one**
incident per subscription and projection revision (`DEVICE_REDUCTION_BLOCKED`).
With stage 6 either ON or OFF, the subscription stays parked from the five-minute
sweep for as long as that incident exists, and «Принять» on it does not change
that. The hourly re-drive keeps re-planning it:

- when the cause clears (the customer removed a device, or the panel link was
  repaired), the reduction goes ahead;
- a new projection revision (another add-on ending, a purchase) starts over.

## Remnawave read-backs on a subscription in the model (no flag)

The panel copies a Remnawave profile back onto an existing subscription in
these places, and all of them follow one rule (`term-model-readback.ts`):

- the `user.*` webhook, which Remnawave sends on each change to a profile;
- «Импорты» → tab «Remnawave» → «Импорт из Remnawave» → «Импортировать», and
  «Синхронизация» → «Запустить синхронизацию» (an existing subscription only);
- the ↻ button (screen-reader label «Синхронизировать») on a subscription:
  «Пользователи» → client → «Подписки»;
- a backup re-import («Импорты» → tab «Remnashop», «Altshop», «STEALTHNET» or
  «Bedolaga» → «Выбрать файл») onto a subscription it already imported, when it
  overlays the live Remnawave profile. The backup's own values, used when the
  panel does not know the profile, are not a Remnawave read and are written as
  before;
- the expired-profile cleanup (every 30 minutes, worker). Before it removes the
  profile of a subscription that ended more than the grace period ago, it asks
  Remnawave for the profile's date, and when that date is later it heals the
  subscription from it instead. It reads the expiry only.

A subscription **outside** the model, and one being created, is handled as
before: the webhook and the import copy limits, expiry and status, and a limit
set in Remnawave lasts until the next renewal. For a subscription **in** the
model (it has a term), decided by the term row and not by any flag:

- **The limits belong to the panel.** No read-back writes a subscription's
  traffic or device limit, in the columns or in the plan snapshot. When the
  profile turns out to hold other limits than the panel would push, the panel
  pushes its own again: one ordinary UPDATE sync job with cause
  `REMNAWAVE_LIMIT_DRIFT`. So **a limit changed directly in Remnawave is put
  back**: within seconds after a webhook or the ↻ button, by the five-minute
  profile-sync sweep after an import. Change a limit in the panel instead:
  «Пользователи» → client → «Подписки» → «Быстрые действия» → «Лимит трафика
  (GB)» / «Лимит устройств» → «Сохранить».
  - Why. In the model a limit is "own share + live add-ons", and the own share is
    read back as the limit less the add-ons. An event from before the panel's
    last push (the push still queued or failing, or the event delivered late)
    carries the OLD limit. Taken as the customer's own, it put the automatic
    device reduction below the plan when an add-on ended, and it brought ended
    add-ons back. Nothing in an event tells such an echo from an edit made in
    Remnawave, so the panel's value wins.
  - Nothing is pushed for a read that is an echo of an older state (see the
    next item), for a profile two live subscriptions name (a duplicate pair:
    merge it with «Слияние подписок-дубликатов»; the worker log names the pair),
    or for a subscription with no panel link.
- **The expiry is taken as before, unless the read is an echo.** A read is an
  echo when the panel's latest push for that subscription (UPDATE or CREATE, not
  superseded) has not completed — queued, running or failed — or completed after
  the read: after Remnawave stamped the event, or after the panel ASKED for the
  profile (an import times its whole run from the moment it started reading, the
  ↻ button from the moment it asked). Then the expiry is not taken, and the push
  carries the panel's own. This keeps a stale read from rolling back a paid
  renewal or bonus days — the ↻ button used to do exactly that when the renewal's
  push had not landed yet — which in the model would also end the add-ons sold
  "until the end of the subscription". An expiry set in Remnawave after the
  panel's last push has landed is still taken.
  - The expired-profile cleanup neither heals nor deletes on such a read: the
    later date it would restore is the one the panel's push is replacing (a
    refund's end, an operator's shortening). It counts the subscription as
    deferred — `pushOfOursNewer` in its «deferred N of M candidate(s)» warning —
    and asks again at the next pass, after the push.
- **The status follows the expiry.** The webhook and the imports take the
  status from a read that is not an echo (Remnawave derives LIMITED and EXPIRED
  from usage and its own clock); from an echo they take neither. The ↻ button
  never writes it; the cleanup sets ACTIVE on a subscription it heals to a
  future date or to no end.
  - An echo is not news, so the webhook tells nobody about it: no «Трафик
    исчерпан» to the customer, no card, no automation, no outbound webhook.
    The event stays in the Activity Feed, and the log says «not taken» or «not
    forwarded». The one-off facts `user.first_connected` and
    `user.traffic_reset` are forwarded however late they arrive.
  - The status after a push is Remnawave's answer to that push: the answer to
    the PATCH or the POST, to the counter reset a renewal makes after its PATCH,
    or the read-back of a versioned write. The profile-sync worker writes it,
    unless a newer push of the panel's is still queued, running or failed. It
    never goes against the panel's own date: never ACTIVE → EXPIRED (autopay may
    still be retrying), never EXPIRED while the date runs, never ACTIVE or
    LIMITED once it has passed. A move into LIMITED tells the customer once.
  - DISABLED comes from an answer only when the push sent no status and the
    client is not blocked: the profile was switched off in Remnawave's own UI
    while the push was on its way. An answer lifts DISABLED only to ACTIVE, and
    only when the push itself sent ACTIVE (the operator switched the
    subscription on, or unblocked the client), or when it sent no status and the
    DISABLED was Remnawave's (the panel's last status decision was not a
    switch-off). A switch-off made in the panel — «Отключить» on the
    subscription, or a block — is never undone by an answer; nor is one made
    before this release, whose value the panel did not record.
  - While the panel's latest push has FAILED («Не применилось в панели: …»),
    the status stays withheld with the expiry until a push goes through. The one
    exception is LIMITED: it is taken, with its notice, when the traffic
    Remnawave reports used is at or over the subscription's own limit (add-ons
    included). It stays withheld when only the panel's unpushed top-up puts the
    limit above the usage. To send the push again: ↻ on the subscription, or
    «Синхронизировать все».
  - The operator's reset («Быстрые действия» → «Сброс трафика» → «Сбросить»)
    counts as a push of the panel's for the status. A `user.limited` Remnawave
    stamped before the reset does not limit the subscription again, and the
    status after the reset is read from Remnawave right after it (the reset
    lifts LIMITED). It outranks neither the expiry nor the limits.
- **A subscription with no end keeps none.** The panel sends Remnawave
  `2099-12-31T00:00:00Z` for it — 2099 is the year Remnawave itself treats as
  no end — and reads any date from 2099 on as "no end". No Remnawave read-back
  writes a date over a subscription with no end, nor an EXPIRED derived from
  such a date: not the webhook, «Импорт из Remnawave» or the ↻ button, in the
  model or outside it, nor a backup re-import in the model; and the cabinet
  shows none. A backup re-import onto a subscription outside the model writes
  what it always wrote, which reads as "no end" once the profile carries 2099.
  - Profiles provisioned before this release carry thirty days from their
    creation. The worker pushes every live linked subscription with no end
    once: at its start and then every 30 minutes, 500 per pass, oldest first,
    as UPDATE sync jobs with cause `PANEL_NO_END_REASSERT` — one per
    subscription, never repeated. Subscriptions a read-back already re-dated
    from those thirty days keep their date until an operator restores them
    («Инструменты» → «Вернуть бессрочность», planned).
- **Where the verdict is recorded.** The worker or API log names each put-back
  and each refusal to push («… holds other limits than subscription …»). For the
  ↻ button the «Журнал аудита» entry `user.sync.requested` carries `panelLimits`
  (`IN_STEP`, `PUT_BACK`, `OUTRANKED`, `PROFILE_DELETED`, `SHARED_PROFILE`,
  `UNLINKED`) and `expiryTaken`, and the subscription's card shows the same
  verdict under the ↻ result: «Лимиты в Remnawave отличались — туда
  отправляются назначенные: …» for a put-back, the reason when none was sent,
  and «Срок из Remnawave не принят: туда ещё не дошло последнее изменение
  подписки.» when a push of the panel's withheld a date that differs. An
  import's put-backs are queued rows the five-minute profile-sync sweep sends.

The comparison of "stamped" and "completed" uses Remnawave's clock against the
panel's for a webhook, so keep both hosts on NTP; a read the panel made on
request is timed on the panel's own clock.

## Customer notices before and at an add-on's end (no flag)

The worker tells the customer about a dated add-on twice: three days before it
ends, and when it has ended. Like the boundary sweep that ends it, this follows
the add-on's row and reads no stage flag: an add-on sold while stage 2 was ON
still ends after stage 2 is turned OFF, and its customer is still told. Add-ons
bought before the model (grandfathered, no end date) never get a notice.

- **When.** Every 10 minutes, one pass at a time (BullMQ job id
  `add-on-expiry-notice-tick`), queued only when an add-on is due; with none
  due, the check is four one-row index reads. «Three days out» is not sent for
  an add-on bought inside those three days, and not again if the add-on's end
  moves later. «Has ended» is sent only while the subscription goes on; an
  add-on that ends together with its subscription is covered by the
  subscription's own «Подписка закончилась».
- **The date it names.** An add-on sold «until the end of the subscription»
  whose end is about to move — bonus days or an edit moved the subscription's
  expiry and the hourly drift sweep has not caught the term up — is not told
  about until the sweep has moved it, so the notice names the new end (and
  says nothing yet if that is more than three days away). The same check runs
  again right before the notice is written.
- **Once.** Each moment is recorded on the add-on's event log (reasons
  `CUSTOMER_NOTICE_ENDS_SOON` / `CUSTOMER_NOTICE_ENDED`, in the same transaction
  as the feed row), so a retry, a restart or a second worker writes no second
  feed row.
- **Channels at least once.** The bot message, the push and the letter go after
  that commit, and a second record (`CUSTOMER_NOTICE_…_DELIVERED`) is written
  once they have run. If the worker dies in between, a pass at least 15 minutes
  later sends them again on the same feed row (the bot and the letter
  deduplicate on it), while the add-on is still in the notice's window. A rare
  duplicate is possible; a lost notice is not.
- **Channels.** Those of the subscription expiry notices: the cabinet feed, the
  bot, web push, and a letter when the customer has a verified address and
  «Уведомления» → «Настройки доставки» → «Email (SMTP)» has «Слать уведомления
  клиентам на почту» on.
- **Texts.** Six templates, edited in «Карта бота» → «Список» (group
  «Уведомления — Истечение») or on the «Уведомления» page: `addon_ends_in_3_days` /
  `addon_ended` (traffic), `addon_devices_ends_in_3_days` /
  `addon_devices_ended` (devices, stage 6 OFF: new devices over the limit do not
  connect), `addon_devices_auto_ends_in_3_days` / `addon_devices_auto_ended`
  (devices, stage 6 ON: the extra devices are disconnected, newest first). The
  sender picks by the add-on's type and `ADDON_DEVICE_CLEANUP_AUTO`. A template
  switched off holds its notices unrecorded; switched back on while they are
  still due (within three days), they go out.
- **Customer's switches.** Two, in the cabinet's «Настройка уведомлений»
  («Дополнительные опции»): three days before, and when it has ended.

## The boundary sweep (no flag)

The boundary sweep runs every 5 minutes on the worker, 200 subscriptions per
tick. It works in this order:

1. **Fresh boundaries first**: ACTIVE add-ons past their end and SCHEDULED terms
   past their start, earliest due first. No row that keeps coming back can stand
   in front of them.
2. **Then device reductions still in progress** (EXPIRING add-ons), oldest first,
   in the room that is left. Rows that wait for an operator are parked, as in
   stage 6.
3. **A DELETED subscription is retired, not expired.** Its live add-ons are
   reversed, its terms closed, its projection marked DELETED and its open device
   plans superseded. It then leaves the selection for good. Before this change,
   such a row threw on every tick.
4. **The term is aligned before anything expires** (next section). An add-on
   that ends with the subscription is not expired at a stale term end after bonus
   days.

### Term alignment

Some fifteen writers move `subscription.expiresAt` without touching the term:
promo, referral and points days, rewards, the operator's editor, bulk
operations, automations, the Remnawave pull and webhook, and anti-fraud. The rule
that keeps the two in step:

- **What moves.** The **tail** term's window follows the subscription's expiry;
  its base never changes. The tail is the last SCHEDULED term if one is queued,
  otherwise the ACTIVE term.
- **Extension.** The tail's end moves to `expiresAt`, and every PENDING or
  ACTIVE add-on that ended with the old tail and is sold "until subscription end"
  moves with it. An add-on with its own earlier date keeps it.
- **Shortening.** The tail's end moves back, and no such add-on is left to
  outlive the subscription. The sweep then expires those that are due.
- **Shortening across a queued SCHEDULED term.** This means moving `expiresAt`
  to or before the start of a renewal that is already paid. Nothing is written,
  and one incident is raised:
  - kind `RECONCILIATION_REQUIRED`;
  - summary code `TERM_SHORTENED_ACROSS_SCHEDULED_TERM`.
- **Lifetime.** A lifetime subscription (`expiresAt` empty) gets an open-ended
  tail, and so do the add-ons that ended with the old tail.
- **Audit.** Each moved add-on gets a version bump and an audit event with reason
  `TERM_WINDOW_ALIGNED`, which carries the old and new dates.
- **When it runs.**
  - Inline, before the sweep expires anything.
  - In an hourly **drift sweep** (at :41) over every subscription, so «Мои
    опции» shows the real end date.

## Rollback

**How to switch stages off.** Set the variable to `false` (or `0`, `off`, `no`)
in `.env` and run `docker compose up -d`. Stages 1, 2 and 6 are ON by default,
so switching the model off means all three:

```
ADDON_ENTITLEMENT_SHADOW=false
ADDON_ENTITLEMENT_DIRECT_PURCHASE=false
ADDON_DEVICE_CLEANUP_AUTO=false
```

**What turning stages off does:**

- **Stage 1 off.** No subscription enters the model any more. The background
  cutover stops: the cron queues no pass, and a pass already queued re-reads the
  flag and does nothing. Payments stop bringing subscriptions in. A subscription
  already in the model keeps getting its terms from renewals, paid upgrades and
  plan changes.
- **Stage 2 off.** New add-on purchases go back to the legacy permanent
  increment. On a subscription already in the model such an increment is kept:
  the next recompute reads it as the subscription's own.
- **Stage 6 off.** Device reductions wait for an operator again.

**What turning stages off does NOT undo:**

- Terms, projections, entitlements and incidents stay. The schema is additive,
  every relation is `Restrict`, and there is no down-migration.
- **Subscriptions already in the model stay in it.** Stage 1 off stops new
  entrants only.
- **Add-ons already sold still end on their dates.** The sweep reads no flag.
- Terms keep being aligned and activated.
- Devices a reduction already removed are not restored.
- **The limits of a subscription in the model stay the panel's.** Remnawave
  read-backs are decided by the term row
  ([Remnawave read-backs](#remnawave-read-backs-on-a-subscription-in-the-model-no-flag)),
  so a limit changed in Remnawave is still put back.

**No plan change waits for stage 1 any more.** «Назначить план», bulk plan
assignment, plan migration, paid upgrades and renewals all decide by the term
row. Switching stage 1 off on an install that already has terms leaves no plan
change on the old term's base, so the next add-on expiry cannot push the old
plan's limits to the panel.

## Verification commands

- **Backend.** Run these:
  - `npm run typecheck`
  - `npm run typecheck:test`
  - `npx eslint <changed files>`
  - the unit specs for `add-on-entitlements`
  - the PostgreSQL job from `.github/workflows/ci.yml`, with `TEST_DATABASE_URL`
    pointing at a fresh PostgreSQL 17 and `--test-concurrency=1`. It covers:
    - `add-on-entitlement-postgres-concurrency`
    - `add-on-cutover-job-postgres`
    - `term-alignment-postgres`
    - `entitlement-boundary-sweep-postgres`
    - `entitlement-deletion-hygiene-postgres`
    - `duplicate-merge-cutover-postgres`
    - `durable-payment-paths-postgres`
    - `lifetime-renewal-postgres`
    - `durable-disposal-postgres`
    - `term-baseline-own-share-postgres`
    - `remnawave-webhook-term-model-postgres`
    - `panel-readback-term-model-postgres`
    - `remnawave-status-term-model-postgres`
    - `remnawave-lifetime-postgres`
    - `backup-reimport-plan-snapshot-postgres`
    - `subscription-refresh-verdict-postgres`
    - `plan-writers-keep-import-keys-postgres`
    - `backup-plan-cloner-postgres`
    - `stripped-plan-snapshot-repair-postgres`
- **Wiring.** Run `npm run build && npm run smoke:boot`.

## Merging duplicates and deleting accounts

A subscription's durable rows that record no money go with it when
«Слияние подписок-дубликатов» retires it or an ordinary user deletion removes
it: the first term the cutover minted, the terms a plan change rotated it onto
(«Назначить план», «Назначить план импортированным», a plan migration), their
projection and closed incidents. Money refuses both: an add-on in any state, a
paid renewal or upgrade term (or one of a source the panel does not know), a
reset period, a device-reduction plan, an OPEN incident. The merge names each
in its refusal; the deletion dialog lists them, and «Удалить полностью» retires
them instead.
