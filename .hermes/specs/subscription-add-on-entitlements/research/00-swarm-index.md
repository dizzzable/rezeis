# Swarm Index

```yaml
created_at: 2026-07-11T20:06:06+03:00
workflow: requirements-first
status: complete
spec_version: 1
run_id: 20260711-200606-9e4bf3
```

## Repositories

| Repository | Revision | Role | Phase-0 status |
|---|---|---|---|
| `V:/REZEIS_ADMIN_RUID_USER/rezeis` | `1111258d3b83edcbe74a142f78ff20b3beace2fc`, `feature/subpage-config` | source of truth, payments, admin, provisioning | clean before spec artifacts |
| `V:/REZEIS_ADMIN_RUID_USER/reiwa` | `721b8159eac2f9b2192c3bb4e464514d4ce41bf8`, `main` | BFF/SPA consumer | clean |

## Lanes

| Lane | Concern | Result |
|---|---|---|
| Codebase/domain | Add-ons, payment fulfillment, subscriptions, renewal, baseline/effective state | completed |
| Contracts/integration | Remnawave 2.7.4/2.8.0, Rezeis↔Reiwa, HWID cleanup | completed |
| Adversarial critic | races, paid failure, migration, security, UX, ops, tests | completed |

Delegation: `deleg_63cc7566`. No child wrote workspace files.

## Parent reconnaissance

Targeted reads/searches covered:

- `rezeis-admin/prisma/schema.prisma`
- `rezeis-admin/src/modules/{add-ons,payments,subscriptions,profile-sync,remnawave}/**`
- `rezeis-admin/web/src/features/add-ons/**`
- `reiwa/src/infrastructure/admin-client/namespaces/add-ons.ts`
- `reiwa/src/api/routes/{content,payments}.ts`
- `reiwa/web/src/features/{addons,renewal,subscription}/**`
- supplied OpenAPI `rezeis/icon/Remnawave API v274.json` and `v280.json`
- focused current tests for payment reconciliation/renewal, profile sync and Remnawave adapter.

## Research safety

Read-only investigation; no dependency install, migration, checkout, provider call, panel mutation, commit, push, tag or release. Parent writes are confined to `.hermes/specs/subscription-add-on-entitlements/**`.
