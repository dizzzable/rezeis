# Reconnaissance

## Repository map

| Repository/package | Role | Evidence |
|---|---|---|
| `rezeis/rezeis-admin` | NestJS/Prisma commercial source of truth, payments, entitlements/provisioning target adapter, workers | `AGENTS.md`; `docs/progress/next-session-handoff.md`; `src/modules/add-ons/**`; `src/modules/payments/**`; `src/modules/profile-sync/**` |
| `rezeis/rezeis-admin/web` | operator Add-on catalog/stats UI | `web/src/features/add-ons/**` |
| `reiwa/src` | Express edge/API and typed internal Rezeis client | `src/infrastructure/admin-client/namespaces/add-ons.ts`; `src/api/routes/**` |
| `reiwa/web` | subscriber Add-on, renewal and subscription UX | `web/src/features/addons/addons-page.tsx`; `web/src/features/renewal/renewal-page.tsx`; dashboard subscription/device components |
| Remnawave | effective provisioning target, not commercial truth | supplied OpenAPI 2.7.4/2.8.0; Rezeis Remnawave service/tests |

## Baseline and rules

- Rezeis root: `V:/REZEIS_ADMIN_RUID_USER/rezeis`, clean at `1111258d3b83edcbe74a142f78ff20b3beace2fc` on `feature/subpage-config`.
- Reiwa root: `V:/REZEIS_ADMIN_RUID_USER/reiwa`, clean at `721b8159eac2f9b2192c3bb4e464514d4ce41bf8` on `main`.
- Read-only spec workflow; only this spec directory may be written.
- No bump/tag/push/release.

## Current-state findings to verify/challenge

1. Current Add-on catalog supports only type/value/applicable plans/prices/active/order, with no lifetime policy.
   - Evidence: `rezeis-admin/prisma/schema.prisma` around `AddOnType`, `AddOn`, `AddOnPrice`; `src/modules/add-ons/dto/admin-add-on.dto.ts`; admin Add-ons form.
2. Current paid top-up mutates `Subscription.trafficLimit` or `Subscription.deviceLimit` directly and queues one profile sync; it has no durable entitlement expiry lifecycle.
   - Evidence: `src/modules/payments/services/payment-subscription-mutation.service.ts` (`applyAddOnTopUp`).
3. Draft checkout snapshots Add-on identity/type/value/name and targets a subscription via payment metadata; fulfillment uses `fulfilledAt` as idempotency claim.
   - Evidence: `src/modules/payments/services/addon-purchase.service.ts`; `payment-reconciliation.service.ts`.
4. Profile sync writes absolute `trafficLimitBytes` and `hwidDeviceLimit` into Remnawave, so concurrent stale jobs may overwrite newer desired state unless projection is serialized/versioned.
   - Evidence: `src/modules/profile-sync/profile-sync.processor.ts` and tests.
5. Remnawave HWID list/delete contracts already exist, and normalized devices expose `createdAt` plus exact `hwid`.
   - Evidence: `src/modules/remnawave/services/remnawave-api.service.ts`; `test/remnawave-api.service.spec.ts`.
6. `user.traffic_reset` is currently logged/mapped but not proof of commercial cycle completion.
   - Evidence: `src/modules/remnawave/services/remnawave-webhook.service.ts`; accepted product rule.
7. Reiwa current internal contract lacks lifetime/entitlement-state fields and purchase quantity/renewal selection semantics.
   - Evidence: `reiwa/src/infrastructure/admin-client/namespaces/add-ons.ts`.
8. Current Reiwa Add-ons page exposes purchase for an existing subscription but must be checked for unlimited-plan filtering, stacking quantity, status visibility and renewal integration.
   - Evidence: `reiwa/web/src/features/addons/addons-page.tsx` and renewal flow.

## Candidate data invariants

- Plan/base commercial limits must remain separate from effective projected limits.
- Every paid Add-on application must correspond to a durable immutable entitlement/purchase snapshot.
- Entitlement activation/expiry must be idempotent and independently recoverable from payment webhook delivery.
- Subscription extension must not silently extend an already-purchased `UNTIL_SUBSCRIPTION_END` Add-on beyond its snapshotted boundary.
- Early renewal Add-ons must begin at the next service-term boundary rather than lose duration before the renewed term starts.
- Projection writes must converge to the latest desired aggregate state.
- Destructive device cleanup must never guess on missing/invalid ordering data.

## Candidate verification commands

### Rezeis backend

- `npm run prisma:generate`
- `npm run typecheck`
- focused Node test files for Add-ons/payment/profile-sync/Remnawave/worker lifecycle
- `npm test` final gate

### Rezeis admin web

- `npx tsc -p tsconfig.app.json --noEmit --incremental false`
- focused Vitest Add-ons tests
- `npm test` and `npm run build` final gates

### Reiwa backend/web

- root: `npm run check`, `npm test`, `npm run build`
- web: package-specific typecheck/tests/build as declared in its manifest

## Planned swarm lanes

1. Codebase/domain lifecycle mapper.
2. Multi-version contracts and cross-repository consumer mapper.
3. Adversarial critic for commerce, concurrency, failure recovery, security/UX/operations/tests.

## Recon commands and sources

- `git rev-parse --show-toplevel`, `git branch --show-current`, `git rev-parse HEAD`, `git status --short` in each repository.
- targeted `search_files`/`read_file` over schema, Add-ons, payments, profile sync, Remnawave, Reiwa Add-ons/renewal/device UI and tests.
- local feature-specification references: orchestration protocol, Rezeis quality gates and multi-version entitlement integration checklist.
