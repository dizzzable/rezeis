# Referral / Partner Settings JSON Contract Proposal

## Purpose

`Settings.referralSettings` and `Settings.partnerSettings` already exist in the
Rezeis Prisma schema as JSON fields.

This file proposes a canonical JSON contract for those fields so the future
Referral and Partner modules can be implemented without inventing settings shape
ad hoc during coding.

Schema anchors:

- `rezeis-admin/prisma/schema.prisma` → `Settings.referralSettings`
- `rezeis-admin/prisma/schema.prisma` → `Settings.partnerSettings`

---

## `Settings.referralSettings`

### Proposed shape

```json
{
  "enabled": true,
  "userDashboardEnabled": true,
  "exchangeEnabled": false,
  "invites": {
    "maxActiveInvitesPerUser": 5,
    "ttlHours": 168,
    "allowBotSource": true,
    "allowWebSource": true,
    "allowUnknownSource": false
  },
  "qualification": {
    "enabled": true,
    "purchaseTypes": ["NEW", "UPGRADE", "RENEW"],
    "channels": ["WEB", "TELEGRAM"],
    "requireCompletedPayment": true,
    "oncePerReferredUser": true
  },
  "rewards": {
    "level1": {
      "enabled": true,
      "type": "POINTS",
      "amount": 100
    },
    "level2": {
      "enabled": false,
      "type": "POINTS",
      "amount": 0
    }
  },
  "exchange": {
    "pointsSource": "REFERRAL_POINTS",
    "allowNegativeBalance": false,
    "auditRequired": true,
    "subscriptionDays": {
      "enabled": true,
      "costPerDay": 10
    },
    "giftPromocode": {
      "enabled": false,
      "allowedPlanIds": [],
      "allowedDurationDays": [30, 90],
      "codePrefix": "GIFT_",
      "maxGenerateAttempts": 20
    },
    "personalDiscount": {
      "enabled": false
    },
    "purchaseDiscount": {
      "enabled": false
    },
    "traffic": {
      "enabled": false
    }
  }
}
```

### Notes

- `pointsSource` is intentionally explicit so referral balance is not confused with
  partner or any future cash-like balance.
- `giftPromocode.enabled` should stay `false` until the referral exchange slice is
  implemented.

---

## `Settings.partnerSettings`

### Proposed shape

```json
{
  "enabled": false,
  "userDashboardEnabled": false,
  "withdrawals": {
    "enabled": false,
    "minimumAmount": 0,
    "supportedMethods": [],
    "manualReviewRequired": true,
    "autoPauseOnSuspicion": true
  },
  "accrual": {
    "strategy": "FIRST_PAYMENT",
    "level1": {
      "rewardMode": "PERCENT",
      "rewardValue": 10
    },
    "level2": {
      "rewardMode": "PERCENT",
      "rewardValue": 0
    },
    "level3": {
      "rewardMode": "PERCENT",
      "rewardValue": 0
    }
  }
}
```

### Notes

- partner balance is money-like ledger state and must not reuse referral exchange
  settings or storage semantics.
- withdrawal settings are grouped separately because they are operational/admin
  workflow settings, not accrual settings.

---

## Validation Rules

Minimum validation expectations for the future implementation:

- unknown keys rejected or normalized explicitly
- enum-like string fields validated at admin write time
- level settings validated consistently (`level1`, `level2`, `level3`)
- withdrawal methods validated against a known allowlist
- disabled sections may still exist in JSON but must not execute business logic

---

## Ownership Rule

These JSON contracts are admin-owned configuration only.

- `rezeis-admin` writes and validates them
- `ruid` only consumes user-safe projections derived from admin-owned decisions
