# Reiwa donor capability map

## STEALTHNET donor capabilities to port carefully

| Donor capability | Reiwa target | Notes |
| --- | --- | --- |
| Telegram registration/login | Reiwa auth/session | Must use safe opaque sessions and bounded Telegram init-data validation. |
| Public config | Reiwa public config | Must not expose provider secrets or raw Remnawave identifiers. |
| Tariffs/plans | Reiwa plans | Source of truth should align with `rezeis-admin` plan catalog. |
| Payments | Reiwa checkout/status | Provider execution should stay server-side and reuse safe Rezeis payment seams where possible. |
| Auto-renew | Later worker/scheduler | Do not add scheduler until exact Rezeis responsibility is defined. |
| Referrals | Reiwa referral UX | Keep admin economics truth in `rezeis-admin` until dedicated user contract exists. |
| Gifts | Reiwa gifts | Needs explicit business contract before schema migration. |
| Tickets/support | Reiwa support UX | Do not expose raw Telegram delivery details. |
| Broadcast/notifications | Reiwa user notification UX | Operator delivery remains admin-owned. |
| Multi-bot clones | Future partner/bot runtime | Useful donor concept, but requires Rezeis-specific ownership design. |
| Landing/branding | Reiwa public shell | Can reuse concept, not raw implementation. |
| Diagnostics/logs | Reiwa observability | Must follow stricter Rezeis safe-disclosure rules. |

## Reuse policy

- Reuse business ideas and flow structure.
- Do not blindly copy raw schema, routes, or permissive diagnostics.
- Keep provider secrets server-side.
- Prefer typed contracts and tests before UI work.
