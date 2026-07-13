# Domain and External Contracts

```yaml
created_at: 2026-07-11T20:18:53+03:00
workflow: requirements-first
status: complete
spec_version: 1
```

## Domain boundary

Rezeis owns commercial baseline, entitlement lifecycle and desired effective state. Remnawave owns current provisioned/usage state only. Reiwa is a typed edge and presentation layer, never an authority for eligibility or prices.

## Remnawave matrix

| Capability | 2.7.4 | 2.8.0 | Normalized rule |
|---|---|---|---|
| User read | `GET /api/users/{uuid}` | same | strict `{response}` validation |
| Limit update | `PATCH /api/users`, UUID in body | same | absolute latest desired projection |
| HWID list | `GET /api/hwid/devices/{userUuid}` | same | strict outcome, validated rows |
| Exact HWID delete | `POST /api/hwid/devices/delete` | same | `{userUuid,hwid}` only |
| Device row owner | `userUuid` | numeric `userId` | ignore row owner; request UUID is authoritative |
| Stable device fields | `hwid,createdAt,updatedAt` | same plus `requestIp` | cleanup uses only `hwid,createdAt` |
| Traffic reset event | `user.traffic_reset` | same | observation, not commercial expiry proof |
| Future reset timestamp | absent | absent | Rezeis owns local epoch/boundary |

## Rezeis↔Reiwa drift

Current contracts omit lifetime, term, quantity/stack identity, entitlement states, baseline/effective split and provisioning status. Catalog upstream failure is masked as an empty list. Checkout response is `unknown` in the internal client. Renewal fingerprint compares insufficient composition for Add-on line items.

## Destructive integration rule

A paid cleanup path must distinguish `ok | notFound | unsupported | unavailable | invalidContract`, validate every HWID row before deletion, persist a deterministic removal plan, exact-delete only planned IDs, and strict-read the postcondition. `/delete-all`, UI order, device names, last-seen and IP are forbidden selectors.

## Unknown vendor semantics

Neither supplied OpenAPI documents complete calendar reset rules. Rezeis must define local UTC cycle policies and verify fixtures against both supported panel versions before enabling `UNTIL_NEXT_RESET` for each strategy.

## Scope conclusion

`rezeis-subpage` has no discovered dependency on catalog, checkout, entitlement, limit or HWID contracts and is out of scope.
