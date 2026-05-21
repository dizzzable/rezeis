# Users / Support Cockpit Read-Side Parity Matrix

Goal: bring the `rezeis-admin` users/support cockpit to **read-side 100%**. Risky mutation execution remains a separate program.

This document is the acceptance contract for read-side completion. A capability is considered read-side complete when the admin panel can safely resolve, explain, preview, or diagnose the state without performing irreversible business mutations.

## Explicit Scope Decision

- In scope: read-only diagnostics, readiness, previews, history, bounded support context, and safe low-risk already-approved actions.
- Out of scope: real role changes, discount/points changes, direct support-message send, subscription renew/extend/reset/limit execution, payment refunds, import commit/rollback, broadcast send, and user-facing provisioning UX.
- `ruid` remains out of scope for this admin-panel read-side completion pass.

## Parity Matrix

| Donor / admin capability | Rezeis read-side status | Evidence in `rezeis-admin` | Remaining read-side gap | Done criterion |
|---|---:|---|---|---|
| User lookup by identifiers | Complete | `/admin/users/search`, `/users/search` | None known | User can resolve by supported identifiers and see bounded profile/session context. |
| Referral-code search-only handoff | Complete | users tracker + search route | None known | Referral code is search-only and does not create mutation side effects. |
| Support snapshot baseline | Complete | users support snapshot section | None known | Operator sees headline, support cues, and bounded context. |
| Identity diagnostics | Complete | identity diagnostics backend/web | None known | Operator sees linked-account readiness without raw risky mutation. |
| Web-account link context | Complete | linked-account diagnostics, prompt/snooze bounded actions, web-account readiness endpoint/card | Real bind/sync mutations out of scope | Operator sees bind/sync readiness with mutation disabled and no raw web-account payload. |
| Moderation state | Complete | block/unblock + moderation history | Real mutations already separated; read-side history done | Operator sees current block state and history. |
| Role mutation readiness | Complete | role readiness endpoint/card | No real role change by scope | Operator sees current role and blockers. |
| Commercial adjustments readiness | Complete | commercial readiness endpoint/card | No real discount/points/max-sub changes by scope | Operator sees current values and blockers. |
| Direct support message readiness | Complete | support-message readiness endpoint/card | No send by scope | Operator sees contact availability and blockers. |
| Unified user action readiness | Complete | `User action readiness overview` in `/users/search` | None known | Operator has one summary across moderation/role/commercial/message/web-account readiness. |
| Current subscription summary | Complete | current subscription card | None known | Operator sees selected subscription context with raw identifiers hidden. |
| All subscriptions workbench | Complete | `/admin/users/subscriptions`, selected workbench | None known | Operator sees safe subscription portfolio and selected detail. |
| Selected subscription devices | Complete | selected devices list/revoke with `deviceRef` | None known | Operator can inspect safe selected devices without raw HWID. |
| Access diagnostics | Complete | backend-owned access diagnostics | Deeper provider trace out of read-side scope | Operator sees entitlement/access outcome and bounded reasons. |
| Device provisioning read-side | Complete for admin side | challenge list/issue/revoke/internal redeem foundation | User-facing/BFF handoff out of scope | Operator sees challenge lifecycle without raw HWID/token/provider payload. |
| Subscription mutation readiness | Complete for read-side | readiness, request draft/history/detail/preflight | Real executor separate | Operator sees planned request state and execution blockers. |
| Queue handoff | Complete baseline | queue sections in users cockpit | None known | Operator sees deferred/invited/recent-user context without unsafe claims. |
| Notifications/read-source context | Complete | readSource normalization | None known | Unknown source never leaks raw codes. |
| Activity / transaction context | Complete baseline | activity/payment support context | Deep finance mutations out of scope | Operator sees safe history cues. |
| Cockpit information architecture | Complete for read-side | overview + collapsible detailed readiness sections | Deep design-system polish out of scope | Operator can scan readiness from overview and expand details only when needed. |

## Completed Read-Side Closure Work

1. **U2 Web-account bind/sync readiness**
   - Backend/web readiness exists for future web-account bind/sync mutation.
   - No bind/sync mutation.

2. **U3 Unified user action readiness overview**
   - Moderation, role, commercial, support-message, and web-account readiness are aggregated into one summary.
   - Existing detailed cards remain below the overview.

3. **U4 Cockpit IA cleanup**
   - Detailed readiness sections are collapsible with independent `<details>/<summary>` wrappers.
   - Overview stays always visible, while detailed readiness noise is opt-in.

4. **U5 Closure tests/docs**
   - This matrix is updated as the read-side acceptance source.
   - Users smoke and web build are the final local gates in the current no-sub-agent session.

## Acceptance Definition For Read-Side 100%

Read-side 100% is reached when:

- every capability above is either marked Complete or explicitly out-of-scope for mutation execution;
- no raw HWID/config URL/provider payload/token/secret is exposed in users cockpit;
- readiness blocks consistently show `mutationEnabled: false` or equivalent for out-of-scope execution;
- web-account bind/sync readiness exists;
- user action readiness has a unified overview;
- users smoke and builds are green.

## U2 Closure - Web Account Bind/Sync Readiness

Shipped read-side behavior:

- backend `GET /admin/users/:userId/web-account-readiness`;
- web `/users/search` card `Web account bind/sync readiness`;
- checks for linked web-account presence, email verification, identity mismatch flags, and governance requirement;
- `mutationEnabled: false`;
- no bind/sync mutation and no raw web-account payload disclosure.

## U3 / U4 Closure - Action Overview And IA Cleanup

Shipped read-side behavior:

- web `/users/search` shows `User action readiness overview` above detailed readiness sections;
- overview summarizes moderation, role, commercial, support-message, and web-account readiness;
- detailed readiness cards are now valid independent collapsible `<details>` sections;
- existing detail data remains available without adding mutation buttons;
- backend contracts are unchanged by the IA cleanup.
