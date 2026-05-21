# Users Module — Device Generation / Provisioning Design Gate

## Status

Partially implemented.

Implemented pieces:

- Phase 1 admin-owned provisioning challenge persistence and admin issue/list seam.
- Phase 2a backend-only Remnawave HWID create transport adapter in `RemnawaveApiService`.
- Phase 2b internal-only challenge redeem endpoint behind `InternalAdminAuthGuard`.

Still blocked:

- user-facing / client-side registration-link device provisioning;
- admin UI direct provider device creation;
- any flow where an operator/browser supplies raw HWID.

This note records the result of the donor and live-code audit for the next users-module donor block after the selected-subscription workbench.

## Donor capability

`altshop` has deeper subscription-device operator flows in the users workbench:

- view subscription devices;
- delete/revoke a selected device;
- edit the subscription device limit;
- navigate those flows from the selected-subscription workbench.

The donor code also treats devices as part of a larger subscription workbench rather than a standalone button.

## Current `rezeis-admin` state

`rezeis-admin` already ships the safe parts of this capability:

- current-subscription device visibility in `/users/search`;
- bounded device revoke through the admin-users wrapper;
- backend-owned access diagnostics;
- multi-subscription portfolio workbench;
- selected-subscription read-only detail;
- minimal-disclosure cleanup so HWID/config/profile payloads are not shown directly in users-cockpit summaries.

Live backend seams currently support:

- `InternalUserService.getSubscriptionDevices()`;
- `InternalUserService.revokeSubscriptionDevice()`;
- `RemnawaveApiService.getUserSubscriptionDevices()`;
- `RemnawaveApiService.revokeUserSubscriptionDevice()`;
- `RemnawaveApiService.createUserSubscriptionDevice()` as a backend-only transport adapter used by the internal redeem service path and reserved for future BFF/client handoff work.

The Remnawave OpenAPI file supplied by the user (`C:\Users\dizzable\Desktop\api-1.json`) confirms provider-level HWID device operations exist:

- `GET /api/hwid/devices` — list all HWID devices;
- `POST /api/hwid/devices` — create a user HWID device;
- `POST /api/hwid/devices/delete` — delete a user HWID device;
- `POST /api/hwid/devices/delete-all` — delete all user HWID devices;
- `GET /api/hwid/devices/{userUuid}` — list one user's HWID devices.

The provider create contract is raw HWID-oriented:

- request schema `CreateUserHwidDeviceRequestDto` requires `hwid` and `userUuid`;
- optional request fields are `platform`, `osVersion`, `deviceModel`, and `userAgent`;
- response schema returns the provider HWID devices list, including raw `hwid` values.

This means the missing `rezeis-admin` capability is **not** provider API existence. Phase 1 now ships the safe admin challenge seam, Phase 2a ships the backend-only provider transport adapter, and Phase 2b ships an internal-only redeem endpoint that can consume a challenge and raw HWID outside the admin browser. The remaining missing capability is the future user-facing/BFF handoff that can obtain device metadata outside the admin browser and call the internal redeem endpoint safely.

Live `rezeis-admin` seams still do **not** currently expose a safe operation for:

- generating a user-facing device setup URL without requiring the operator to provide raw HWID;
- changing a subscription device limit as an admin support action;
- returning provider-level node/profile/connectivity internals for an operator device-generation flow.

`rezeis-admin` does expose the first safe building block now: operators can issue/list bounded provisioning challenges. That challenge does not create provider devices and does not return token/secret/HWID/provider payloads.

## Phase 2a transport adapter boundary

`RemnawaveApiService.createUserSubscriptionDevice()` is intentionally backend-only.

It may accept raw HWID only from the shipped internal redeem endpoint or a future trusted BFF/client handoff, not from `rezeis-admin/web` or an operator form. The method:

- resolves provider `userUuid` from the selected Remnawave subscription id inside the backend;
- trims and validates HWID server-side;
- calls `POST /api/hwid/devices` with `userUuid`, `hwid`, and optional device metadata;
- maps the provider response into the existing internal `RemnawaveSubscriptionDevicesInterface`;
- remains unexposed through admin users endpoints; it is callable only through the internal redeem service path.

The adapter is not sufficient by itself for UI exposure because it still requires raw HWID input and receives raw provider HWID device payloads.

## Phase 2b internal redeem endpoint boundary

`POST /internal/users/device-provisioning-challenges/:challengeId/redeem` is intentionally internal-only.

It is protected by `InternalAdminAuthGuard` and may accept raw HWID only from a future trusted backend/BFF seam, not from `rezeis-admin/web` or an operator form. The endpoint:

- validates that the challenge is active, pending, unexpired, unrevoked, and unconsumed;
- resolves the target user/subscription from the persisted challenge;
- calls the backend-only `RemnawaveApiService.createUserSubscriptionDevice()` adapter;
- marks the challenge `CONSUMED` only after successful provider creation;
- returns only bounded redemption status and device count;
- does not return raw HWID, provider `userUuid`, challenge secret/hash, or raw provider device payload.

The endpoint is still not a user-facing provisioning UX. It is a backend seam that a future BFF/client can call after collecting device metadata outside the admin browser.

## Why frontend-only implementation is not acceptable

A fake panel button for device generation would be unsafe because it would imply an operator action without a source of truth for:

- who is allowed to generate the link;
- whether the selected subscription is eligible;
- whether a link should be one-time, expiring, revocable, or audited;
- whether generation mutates provider state;
- how to avoid exposing raw config URLs, UUIDs, HWIDs, tokens, or provider payloads;
- how generated links are recorded for audit and replay prevention.

## Remaining user-facing handoff before final provisioning UX

Before user-facing provisioning can be complete, a future BFF/client handoff must intentionally define who may call the internal redeem endpoint, how device metadata is collected, how replay/attempt limits are surfaced to users, and how errors are mapped without exposing provider payloads. Phase 1 challenge issuance, Phase 2a provider transport, and Phase 2b internal redeem are prerequisites, not the final user-facing flow.

## Shipped admin challenge route shape

The admin-owned challenge seam is no longer a suggested future endpoint. Phase 1 shipped the concrete admin route shape below:

```http
GET /admin/users/device-provisioning-challenges?userId=<uuid>&subscriptionId=<uuid>
POST /admin/users/device-provisioning-challenges?userId=<uuid>&subscriptionId=<uuid>
PATCH /admin/users/device-provisioning-challenges/:challengeId/revoke?userId=<uuid>&subscriptionId=<uuid>
```

The admin seam is challenge-oriented only. It lets operators list, issue, and revoke bounded provisioning challenges. It does not redeem challenges, does not accept raw HWID, and does not call Remnawave create-device directly from the admin browser.

## Remnawave TypeScript SDK integration path

Remnawave documents an official TypeScript SDK at `https://docs.rw/docs/sdk/typescript-sdk`.

Important implementation notes from the documentation:

- the package is `@remnawave/backend-contract`;
- it is official and maintained by the Remnawave team;
- it provides REST API contract types, endpoint metadata, URLs, and schemas;
- it **does not include an HTTP client**, so the application must keep its own transport layer;
- the package version must be pinned to the deployed Remnawave Panel version.

`rezeis-admin` already follows this model in `RemnawaveApiService`: it imports command contracts from `@remnawave/backend-contract` and performs the HTTP calls through Nest `HttpService`.

Future provisioning implementation should continue this pattern:

- use the official Remnawave command contract when a suitable provisioning/device command exists;
- validate Remnawave responses with the SDK schema before mapping them into admin-safe DTOs;
- keep transport, authorization headers, failure handling, and bounded admin response mapping inside `RemnawaveApiService` or a dedicated backend service;
- never pass SDK/raw response payloads directly to `rezeis-admin/web`.

The Remnawave API specification entrypoint is `https://docs.rw/api/`, including the auth-controller section at `https://docs.rw/api/#tag/auth-controller`. A version-specific Scalar API reference candidate is `https://client.scalar.com/@local/default/document/remnawave-api-v274/overview`. Future implementation must verify the deployed panel's API/auth behavior against the matching API spec version before adding any provisioning operation. This document does not treat the auth-controller link or the Scalar overview as provisioning endpoints; they are recorded as official/version-specific API references for the transport layer.

The shipped admin request boundary is:

- canonical `userId` resolved by the admin users cockpit;
- selected `subscriptionId` that must belong to that user;
- optional bounded reason/comment for audit;
- no raw HWID, config URL, token, provider UUID, or profile payload from the operator.

The shipped admin response boundary is:

- `challengeId` or `provisioningId`;
- `expiresAt`;
- coarse `status` such as `ISSUED`, `BLOCKED`, or `REQUIRES_REVIEW`;
- bounded `reasons[]` with stable codes;
- bounded `nextActions[]`;
- bounded status and next-action metadata only; no provider/config/connectivity material is displayed to operators.

The response must not include:

- raw provider config URL;
- Remnawave raw payload;
- raw subscription UUIDs beyond the selected row id already known to the admin seam;
- HWID;
- access tokens;
- profile/node/connectivity internals.

## Required backend checks

The backend seam must enforce:

- admin authorization;
- subscription ownership by requested user;
- subscription status eligibility;
- access-mode/platform-policy compatibility;
- device-limit state;
- audit logging;
- idempotency or replay controls;
- safe expiration semantics;
- provider failure degradation with bounded error codes.

## Final provisioning UX acceptance boundary after trusted client handoff exists

When the trusted BFF/client handoff exists, the users cockpit may add a bounded selected-subscription action area that:

- appears only inside the selected-subscription workbench;
- explains eligibility and blockers before action;
- requires explicit operator confirmation;
- displays only the backend-approved bounded response;
- never asks the operator to paste raw provider values;
- never exposes raw HWIDs, config URLs, UUIDs, tokens, or provider payloads to the admin/operator UI.

## Current decision

Do not implement direct device generation/provisioning UI yet.

The current correct implementation state is to keep the shipped read-only device visibility, revoke, access diagnostics, multi-subscription workbench, selected-subscription detail, Phase 1 challenge issuance, Phase 2a backend-only Remnawave transport adapter, and Phase 2b internal redeem endpoint, while marking final user-facing registration-link provisioning as blocked until the future BFF/client handoff is intentionally designed and implemented.

The OpenAPI evidence lowered one unknown: Remnawave exposes raw HWID creation. The Phase 2a adapter now covers that provider transport inside the backend, and Phase 2b provides an internal redeem endpoint around it. It still does **not** complete user-facing provisioning because the final BFF/client handoff must collect device metadata outside the admin browser and must call the internal endpoint without exposing raw provider payloads to operators.
