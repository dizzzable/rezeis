# Users / Search / Support Actions - Master Tracker

## Purpose

This is the durable master tracker for the `Users / search / support actions` donor-module transfer from `altshop` into `rezeis-admin`.

The tracker exists to prevent scope drift. It records what is shipped, what still needs contract cleanup, what is blocked by missing backend/admin seams, and what rule must be satisfied before any new users-cockpit slice is opened.

## Product Boundary

- `rezeis-admin` is the implementation surface for this tracker.
- `altshop` is the donor for users-module business logic and operator workflow ideas.
- `backend-main` / Remnawave is the donor for architecture, reliability, and backend implementation standards.
- `ruid` remains out of scope for this tracker unless a future plan explicitly reopens it.
- Read-side completion scope is governed by `docs/architecture/users-support-cockpit-parity-matrix.md`: Users/support cockpit read-side can be considered complete without implementing risky mutation execution. Role changes, discount/points changes, support-message sending, subscription mutation execution, and user-facing provisioning remain separate mutation programs.

## Closed / Shipped Slices

The following slices are shipped in live code and should not be reopened without a new, explicit acceptance boundary.

1. `/users/search` as the main operator cockpit.
2. Search resolution including `referralCode` as a search-only identifier.
3. Queue handoff from `recent-registered`, `blacklist`, and `invited` into `/users/search`.
4. Read-only support snapshot for the resolved user.
5. `identityDiagnostics` in the bounded `/admin/users/search` response.
6. Bounded linked web-account actions: `accept rules`, `snooze link prompt`, and `issue email verification challenge`.
7. Payment and notification activity context.
8. Activity drill-down with bounded load-more behavior.
9. Referral support drill-down with recent invites/rewards and no raw invite token exposure.
10. Subscription action-policy drill-down with allowed/blocked actions, available plans, warnings, and `/subscriptions/quote` handoff.
11. Current-subscription support cues for expiry and limits, with config URLs hidden after minimal-disclosure cleanup.
12. Current-subscription devices with bounded revoke-by-HWID.
13. Web-only Access Diagnostics over the current subscription, device envelope, and action-policy snapshot, with loading/error-honest device-count state.
14. Cross-context support guidance across identity, subscription, referral, partner, and policy signals.
15. Identity reconciliation support cues using existing diagnostics and linked-account state.
16. Snapshot priority / risk cues for top-level operator triage.
17. Baseline invited queue support on the real direct-referral admin seam, including queue handoff into `/users/search`.
18. Invited queue enrichment with direct inviter context and invited timestamp.
19. Invited qualification cues with `qualifiedAt` and `qualifiedPurchaseChannel` when present.
20. Queue-row web-status markers for `recent-registered`, `blacklist`, and `invited`.
21. Backend-owned per-user access diagnostics with minimal-disclosure verdict, reasons, facts, and next safe actions.
22. Backend-owned multi-subscription read-only workbench with safe subscription rows, current-candidate marker, portfolio summary, and risk markers.
23. Backend-owned selected-subscription read-only detail with safe entitlement, capacity, next-action, and risk-marker summaries.
24. Phase 1 admin device provisioning challenge with backend-owned persistence, minimal-disclosure challenge responses, opaque `deviceRef` for admin device rows, and no Remnawave create-device call from the panel.
25. Phase 2a backend-only Remnawave HWID create transport adapter in `RemnawaveApiService`; this is not exposed through admin users API or web UI and is consumed only by the internal redeem path.
26. Phase 2b internal-only device provisioning challenge redeem endpoint protected by `InternalAdminAuthGuard`; it consumes active challenges, calls the backend-only Remnawave adapter, and returns bounded redemption status without raw HWID/provider payloads.

## Shipped But Needing Contract / Documentation Cleanup

These are not new feature slices. They are cleanup tasks that make the master plan and live contract less ambiguous.

1. **Notification `readSource` normalization audit**
   - Live UI maps known values including `ADMIN_PANEL`, `INTERNAL_ADMIN`, `BOT`, and `WEB`.
   - Unknown or unsupported values fall back to safe localized operator copy instead of raw backend codes.
   - Keep this bounded unless backend formalizes `readSource` as an enum contract.

2. **Queue semantics definition**
   - `recentRegistered` is currently a latest-N list ordered by `createdAt`, not a formal time-window queue.
   - `blacklist` is the blocked-users list ordered by `createdAt`.
   - `invited` is shipped as a direct-referral-backed queue using the existing admin referral seam; only donor-style invite-source and broader purchase-attribution depth remain blocked.

3. **Search contract reference cleanup**
   - Any older docs/tests that model the web search contract without `referralCode` are stale as master references.
   - `referralCode` must remain search-only and must not bleed into sibling action/device routes.

4. **Acceptance-boundary backfill for foundational slices**
   - Early slices such as search resolution, queue handoff, support snapshot baseline, identity diagnostics, and device revoke should keep explicit boundaries if they are discussed again.

## Blocked Until A Real Backend/Admin Seam Exists

These donor capabilities should stay blocked. Do not simulate them in the panel UI without a real source of truth.

1. `recent-active` queue.
2. Donor-style panel-sync, web-bind target preview, or reclaim-preview workflows.
3. Donor-style selected-subscription operator workbench depth beyond the shipped read-only portfolio/detail summaries, such as profile/node/connectivity/squad context or mutation flows.
4. Attach-referrer workflow.
5. Broader recovery, takeover, impersonation, or password/MFA support flows.
6. User-facing registration-link / client-side device provisioning flows beyond the shipped admin challenge, backend-only Remnawave transport adapter, and internal redeem endpoint, as documented in `docs/architecture/users-device-generation-provisioning-design.md`.
7. Deeper access diagnostics beyond the shipped backend-owned summary, such as source-specific denial traces, historical access decisions, or provider-level entitlement explanations.
8. Assignment/lifecycle subscription mutations.
9. Donor-style invited queue depth beyond the shipped direct-referral seam, such as invite-source attribution or broader purchase-source context, unless the backend exposes an honest admin contract.

## Donor Lessons That Still Matter

`altshop` treats the users module as a full operator workbench, not a single search screen. The most important donor ideas are:

- fast search and queue entry points;
- identity reconciliation before action;
- subscription-centered support context;
- referral and partner attribution visibility;
- explicit blocked states when source-of-truth data is missing.

In `rezeis-admin`, these ideas must be adapted to existing seams instead of copied directly.

## Ongoing Implementation Rule

No new users-cockpit slice should be opened unless it satisfies one of these conditions:

1. It reuses an existing admin read seam without widening risky mutation scope.
2. It is preceded by a new backend/admin seam with explicit acceptance criteria.
3. It is pure documentation or contract cleanup that reduces ambiguity in the shipped module.

If a donor feature requires missing source-of-truth data, mark it blocked instead of creating a fake frontend state.

## Safety Rules That Still Apply

- Users/support stays read-only by default.
- Any support action must stay bounded.
- No passwords, MFA secrets, recovery artifacts, raw verification codes, tokens, or impersonation/takeover behavior may appear in the panel.
- Queue rows may expose operator markers, but must not become mini-workbenches.
- Search-only identifiers such as `referralCode` must not bleed into sibling mutation routes.

## Acceptance Boundary Index

### Search Resolution And Referral-Code Lookup

- Uses `/admin/users/search` as the single admin users cockpit lookup seam.
- `referralCode` is accepted only by the search route and resolves to a canonical user before downstream reads/actions.
- Search-only identifiers must not be forwarded to sibling routes such as devices, linked-account actions, access diagnostics, subscription workbenches, or provisioning seams.
- The web client must call downstream support reads with the canonical resolved `userId`, not with the original search input.
- No takeover, password, MFA, recovery-code, raw verification-code, or impersonation behavior belongs to this slice.

### Queue Handoff

- Queue pages may link into `/users/search` with `userId` and bounded `from` context only.
- The search page hydrates queue context once and then clears stale queue handoff context after a manual search.
- Queue rows remain read-only entry points; they must not become mini-workbenches or mutation surfaces.
- Queue handoff must not introduce new backend queue semantics beyond the queue source it already uses.

### Support Snapshot Baseline

- The snapshot is read-only and aggregates already available safe user/session/subscription context.
- It must not expose passwords, MFA/recovery data, verification codes, tokens, raw provider payloads, raw HWIDs, or raw config URLs.
- It may provide operator orientation and handoff links, but not risky direct account-control behavior.
- Any added snapshot cue must handle loading/error/partial-data states honestly instead of treating missing ancillary reads as absence.

### Identity Diagnostics Baseline

- Uses backend-produced `identityDiagnostics` from `/admin/users/search`.
- Shows lookup path, linked-account status, mismatch flags, and bounded guidance only.
- Unknown statuses or guidance codes must degrade to safe operator copy rather than raw translation keys or backend enum leakage.
- Diagnostics do not perform merge, relink, reclaim, panel-sync, takeover, or impersonation flows.

### Current-Subscription Devices And Revoke

- Uses admin users device wrapper routes over the existing current-subscription devices seam.
- Device rows expose opaque `deviceRef` only; raw HWID is never rendered or sent by the web client.
- Revoke remains a bounded support action and resolves raw HWID backend-side before calling provider/internal device revoke.
- Device count/loading/error states must be honest; no fake `0 / N` display before the device envelope loads.
- Revoke must stay tied to the resolved canonical user and current subscription context.

### Activity Drill-Down

- Uses existing paginated activity seams.
- Payment and notification activity stay read-only.
- Load-more resets cleanly when a new search starts.

### Referral Support Drill-Down

- Reuses existing referrals summary/invites/rewards reads.
- Stays read-only inside `/users/search`.
- Does not expose raw invite tokens.
- Hands off full invite management to `/growth/referrals`.

### Subscription Support Drill-Down

- Reuses existing action-policy reads.
- Shows allowed/blocked actions, available plans, and warnings.
- Links to `/subscriptions/quote` without embedding quote/checkout mutations.

### Current-Subscription Support Cues

- Reuses the aggregated `/admin/users/search` subscription payload.
- Shows expiry and limits without exposing raw config URLs.
- Config URLs are not rendered in the users cockpit after the minimal-disclosure cleanup.

### Cross-Context Guidance

- Reuses identity, subscription, referral, partner, and policy reads.
- Stays read-only.
- Handles loading/error states without hiding still-valid rows.

### Identity Reconciliation

- Reuses identity diagnostics, linked-account status, mismatch flags, and normalized web-account fields.
- Does not expose merge, relink, takeover, or recovery controls.
- Handles unknown statuses/guidance codes with safe fallback copy.

### Invited Queue Enrichment

- Reuses the real direct-referral admin queue source; this baseline invited queue is shipped, not frontend-faked.
- Shows inviter context, invited timestamp, and qualification cues when present.
- Does not create a second referral workspace.
- Does not claim donor-style invite-source or broader purchase-attribution depth; those remain blocked until a real backend/admin seam exists.

### Queue Web-Status Markers

- Reuses `User.webAccount` and `referred.webAccount` relations.
- Exposes only marker-level status cues.
- Does not expose linked web-account login or email in queue rows.

### Snapshot Priority / Risk Cues

- Reuses existing identity, subscription, referral, partner, and action-policy reads.
- Stays read-only and creates no workflow controls.
- Loading/error states do not overstate absence.

### Web-Only Access Diagnostics

- Reuses the existing current-subscription devices envelope.
- Reuses current subscription and action-policy data already present in `/users/search`.
- Stays read-only and adds no new device actions.
- Device count state is loading/error-honest.
- After the device envelope loads successfully, access state, device capacity, subscription anchor, and next safe path are shown once through the diagnostics strip.
- Device-envelope loading and error states are handled by the surrounding devices card badge/body instead of rendering the diagnostics strip prematurely.
- Does not claim backend-owned entitlement traces, historical denials, or real-time gate explanations.

### Backend-Owned Access Diagnostics

- Uses `GET /admin/users/access-diagnostics` as the backend-owned per-user access-status seam.
- Returns minimal-disclosure diagnostics only: `accessState`, `primaryReasonCode`, bounded `reasons`, bounded `facts`, bounded `operatorNextActions`, and `checkedAt`.
- Does not return raw user identifiers, web login/email, config URLs, HWIDs, raw search payloads, raw subscription payloads, or raw device payloads.
- Uses canonical resolved `userId` after search, including referral-code searches, so search-only identifiers do not bleed into the diagnostics endpoint.
- Handles no-current-subscription and device-envelope failure paths without crashing and without calling action-policy with an empty subscription id.
- Backend and web coverage exists for service aggregation, controller/http route, typed client, web card, referral-code canonicalization, no-subscription behavior, and device-error behavior.

### Multi-Subscription Read-Only Workbench

- Uses `GET /admin/users/subscriptions` as the backend-owned read-only subscription portfolio seam.
- Returns safe subscription rows only: status, trial marker, plan snapshot summary, limits, dates, current-candidate marker, and risk markers.
- Does not return config URLs, Remnawave raw data, raw subscription UUIDs, profile payloads, node/connectivity payloads, or device/HWID payloads.
- Renders in `/users/search` for any resolved user after the backend workbench response, including users with no current subscription in the main search snapshot.
- Does not introduce assignment, renewal, generation, selected-subscription mutation, or lifecycle actions.
- Backend and web coverage exists for service aggregation, controller/http route, typed client, workbench card, null-current-subscription rendering, and scoped build/test verification.

### Selected-Subscription Read-Only Detail

- Uses `GET /admin/users/subscriptions/selected` as the backend-owned selected-subscription detail seam.
- Requires both canonical `userId` and `subscriptionId`, and only returns a detail row when that subscription belongs to the requested user.
- Returns safe selected-subscription detail only: summary, entitlement state, capacity snapshot, next safe actions, and risk markers.
- Does not return config URLs, Remnawave raw data, raw subscription UUIDs beyond the selected row id, profile payloads, node/connectivity payloads, or device/HWID payloads.
- Renders in `/users/search` after the multi-subscription workbench selects a row and does not require the main search snapshot to have a current subscription.
- Does not introduce selected-subscription mutation, assignment, renewal, generation, or lifecycle actions.
- Backend and web coverage exists for service aggregation, controller/http route, typed client, selected detail card, and scoped build/test verification.

### Phase 1 Admin Device Provisioning Challenge

- Uses backend-owned `AdminDeviceProvisioningChallenge` persistence and admin guarded endpoints.
- Issues only an admin-owned challenge record; it does not call Remnawave `POST /api/hwid/devices` and does not create provider HWID devices.
- Reuses active pending challenges instead of generating duplicate pending records for the same subscription/user support flow.
- Enforces `subscriptionId + userId` ownership before listing or issuing challenges.
- Does not return challenge secret, token, hash, idempotency key, raw HWID, userUuid, or Remnawave provider payloads.
- Admin current-subscription devices use opaque `deviceRef`; raw HWID is resolved only backend-side for revoke and is not exposed through `rezeis-admin` API/UI.
- Backend and web coverage exists for persistence contract, service aggregation, controller/http routes, typed client, provisioning panel, opaque device refs, and scoped build/test verification.

### Phase 2a Remnawave HWID Transport Adapter

- Adds a backend-only adapter for Remnawave OpenAPI v274 `POST /api/hwid/devices`.
- Is not exposed through `rezeis-admin` admin users API, web UI, or provisioning challenge responses.
- Resolves provider `userUuid` server-side from the selected Remnawave subscription id.
- Validates and normalizes HWID server-side before the provider call.
- Maps provider response into the existing internal subscription-devices interface rather than returning raw provider payloads to operators.
- Backend tests prove request shape, normalization, response mapping, and blank-HWID rejection before provider calls.
- Final user-facing provisioning remains blocked until a future BFF/client handoff integrates the shipped internal redeem contract safely.

### Phase 2b Internal Device Provisioning Challenge Redeem

- Adds `POST /internal/users/device-provisioning-challenges/:challengeId/redeem` behind `InternalAdminAuthGuard`.
- Accepts raw HWID only from the internal backend/BFF seam, not from `rezeis-admin/web` or operator forms.
- Validates active, non-expired, non-revoked, non-consumed challenge state before provider creation.
- Calls the backend-only Remnawave HWID adapter and consumes the challenge on success.
- Returns only bounded redemption status and device count.
- Does not return raw HWID, provider `userUuid`, challenge secret/hash, or provider device payload.

## Next Decision Guidance

The current honest next step is not another UI summary card inside `/users/search` unless a new read seam is identified.

Recommended next directions are:

1. finish the remaining contract/documentation cleanup from the list above;
2. design and implement the user-facing/client-side registration-link handoff only as a future BFF/client integration with the shipped internal redeem endpoint;
3. backend-first design for deeper selected-subscription profile/node/connectivity/squad context only after a real source-of-truth seam exists;
4. avoid adding more frontend-only summaries to `/users/search` until one of those backend seams exists.

### Contract cleanup: selected-subscription mutation drafts

- The selected-subscription mutation draft contract now stays intentionally non-secret and summary-only.
- `POST /admin/users/subscriptions/selected/mutation-requests` returns `reasonRequired`, `reasonProvided`, and `idempotencyKeyPresent` instead of echoing the operator reason or idempotency key.
- The web client unwraps the standard API envelope for this endpoint and validates the same DTO shape as the backend interface.
- The reason remains stored only in the admin audit log metadata for operator accountability; the UI receives presence booleans only.

Do not reopen `recent-active`, panel-sync, web-bind preview, reclaim preview, selected-subscription donor depth, or donor-style invited invite-source attribution until a backend/admin seam is explicitly designed.

## Related Durable Notes

- `docs/architecture/users-phase-3-linked-web-account-actions.md`
- `docs/architecture/users-device-generation-provisioning-design.md`

This tracker should be updated every time a bounded users-module slice closes.
