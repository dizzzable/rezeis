# API Documentation

This document describes the Rezeis API endpoints.

## 📋 Table of Contents

- [Authentication](#authentication)
- [Base URL](#base-url)
- [Response Format](#response-format)
- [Users API](#users-api)
- [Subscriptions API](#subscriptions-api)
- [Partners API](#partners-api)
- [Promocodes API](#promocodes-api)
- [WebSocket](#websocket)
- [Error Codes](#error-codes)

## 🔐 Authentication

### Login

```http
POST /api/auth/login
Content-Type: application/json

{
  "username": "admin",
  "password": "your_password"
}
```

**Response:**

```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": "uuid",
    "username": "admin",
    "role": "super_admin"
  }
}
```

### Telegram WebApp Auth

```http
POST /api/auth/telegram
Content-Type: application/json

{
  "initData": "query_id=xxx...",
  "expires_at": 1234567890
}
```

### Refresh Token

```http
POST /api/auth/refresh
Content-Type: application/json

{
  "refreshToken": "your_refresh_token"
}
```

### Get Current User

```http
GET /api/auth/me
Authorization: Bearer <access_token>
```

**Response:**

```json
{
  "id": "uuid",
  "username": "admin",
  "email": "admin@example.com",
  "telegram_id": "123456789",
  "role": "super_admin",
  "created_at": "2025-01-01T00:00:00Z"
}
```

## 🌐 Base URL

| Environment | URL |
|-------------|-----|
| Production | `https://your-domain.com/api` |
| Development | `http://localhost:4001/api` |

## 📦 Response Format

### Success Response

```json
{
  "success": true,
  "data": { ... },
  "meta": {
    "page": 1,
    "limit": 20,
    "total": 100
  }
}
```

### Error Response

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid input data",
    "details": [
      {
        "field": "email",
        "message": "Invalid email format"
      }
    ]
  }
}
```

## 👥 Users API

### List Users

```http
GET /api/users?page=1&limit=20&search=john
Authorization: Bearer <access_token>
```

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `page` | number | Page number (default: 1) |
| `limit` | number | Items per page (default: 20) |
| `search` | string | Search by username or email |
| `role` | string | Filter by role |
| `status` | string | Filter by status |

**Response:**

```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "username": "john_doe",
      "email": "john@example.com",
      "telegram_id": "123456789",
      "status": "active",
      "created_at": "2025-01-01T00:00:00Z"
    }
  ],
  "meta": {
    "page": 1,
    "limit": 20,
    "total": 100
  }
}
```

### Get User

```http
GET /api/users/:id
Authorization: Bearer <access_token>
```

### Create User

```http
POST /api/users
Authorization: Bearer <access_token>
Content-Type: application/json

{
  "username": "new_user",
  "email": "new@example.com",
  "password": "secure_password",
  "telegram_id": "123456789"
}
```

### Update User

```http
PATCH /api/users/:id
Authorization: Bearer <access_token>
Content-Type: application/json

{
  "email": "new_email@example.com",
  "status": "suspended"
}
```

### Delete User

```http
DELETE /api/users/:id
Authorization: Bearer <access_token>
```

## 📋 Subscriptions API

### List Subscriptions

```http
GET /api/subscriptions?page=1&limit=20&user_id=uuid
Authorization: Bearer <access_token>
```

### Get Subscription

```http
GET /api/subscriptions/:id
Authorization: Bearer <access_token>
```

### Create Subscription

```http
POST /api/subscriptions
Authorization: Bearer <access_token>
Content-Type: application/json

{
  "user_id": "uuid",
  "plan_id": "uuid",
  "duration_days": 30,
  "discount_percent": 10
}
```

### Renew Subscription

```http
POST /api/subscriptions/:id/renew
Authorization: Bearer <access_token>
Content-Type: application/json

{
  "duration_days": 30,
  "apply_promocode": "SAVE10"
}
```

### Cancel Subscription

```http
POST /api/subscriptions/:id/cancel
Authorization: Bearer <access_token>
```

### Multi-Subscriptions

```http
GET /api/multisubscriptions/user/:user_id
Authorization: Bearer <access_token>
```

## 🤝 Partners API

### Get Partner Profile

```http
GET /api/partners/me
Authorization: Bearer <access_token>
```

**Response:**

```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "user_id": "uuid",
    "level": "gold",
    "total_earnings": 1000.00,
    "pending_earnings": 100.00,
    "paid_earnings": 900.00,
    "referral_count": 25,
    "commission_rate": 0.15
  }
}
```

### Get Referrals

```http
GET /api/partners/me/referrals
Authorization: Bearer <access_token>
```

### Request Payout

```http
POST /api/partners/me/payout
Authorization: Bearer <access_token>
Content-Type: application/json

{
  "amount": 500.00,
  "method": "crypto",
  "wallet_address": "0x..."
}
```

### Admin: List Partners

```http
GET /api/admin/partners?page=1&level=gold
Authorization: Bearer <access_token>
```

### Admin: Update Partner Level

```http
PATCH /api/admin/partners/:id/level
Authorization: Bearer <access_token>
Content-Type: application/json

{
  "level": "platinum"
}
```

## 🎫 Promocodes API

### List Promocodes

```http
GET /api/promocodes
Authorization: Bearer <access_token>
```

### Get Promocode

```http
GET /api/promocodes/:code
Authorization: Bearer <access_token>
```

### Create Promocode

```http
POST /api/promocodes
Authorization: Bearer <access_token>
Content-Type: application/json

{
  "code": "SUMMER2025",
  "type": "percentage",
  "value": 20,
  "max_uses": 100,
  "expires_at": "2025-08-31T23:59:59Z",
  "applicable_plans": ["uuid1", "uuid2"]
}
```

### Validate Promocode

```http
POST /api/promocodes/validate
Content-Type: application/json

{
  "code": "SUMMER2025",
  "plan_id": "uuid"
}
```

**Response:**

```json
{
  "success": true,
  "data": {
    "valid": true,
    "discount": {
      "type": "percentage",
      "value": 20,
      "final_price": 40.00
    }
  }
}
```

### Activate Promocode

```http
POST /api/promocodes/:code/activate
Authorization: Bearer <access_token>
Content-Type: application/json

{
  "user_id": "uuid",
  "subscription_id": "uuid"
}
```

### Delete Promocode

```http
DELETE /api/promocodes/:id
Authorization: Bearer <access_token>
```

## 📊 Analytics API

### Dashboard Stats

```http
GET /api/analytics/dashboard
Authorization: Bearer <access_token>
```

### Revenue Report

```http
GET /api/analytics/revenue?from=2025-01-01&to=2025-01-31
Authorization: Bearer <access_token>
```

### User Statistics

```http
GET /api/analytics/users?period=monthly
Authorization: Bearer <access_token>
```

## 🖥️ Monitoring API

### Server Status

```http
GET /api/monitoring/servers
Authorization: Bearer <access_token>
```

**Response:**

```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "name": "Server 1",
      "status": "online",
      "cpu_usage": 45.5,
      "memory_usage": 60.2,
      "bandwidth_in": 1024000,
      "bandwidth_out": 2048000,
      "active_connections": 150
    }
  ]
}
```

### Server History

```http
GET /api/monitoring/servers/:id/history?from=2025-01-01&to=2025-01-31
Authorization: Bearer <access_token>
```

## 🔔 Notifications API

### List Notifications

```http
GET /api/notifications?type=all&read=false
Authorization: Bearer <access_token>
```

### Send Broadcast

```http
POST /api/notifications/broadcast
Authorization: Bearer <access_token>
Content-Type: application/json

{
  "title": "Maintenance Notice",
  "message": "System maintenance scheduled for Sunday",
  "recipients": "all",
  "send_telegram": true
}
```

### Mark as Read

```http
PATCH /api/notifications/:id/read
Authorization: Bearer <access_token>
```

## 📈 Statistics API

### Daily Statistics

```http
GET /api/statistics/daily?date=2025-01-15
Authorization: Bearer <access_token>
```

### Subscription Statistics

```http
GET /api/statistics/subscriptions?period=month
Authorization: Bearer <access_token>
```

### Export Data

```http
GET /api/statistics/export?format=csv&type=users
Authorization: Bearer <access_token>
```

## 🔌 WebSocket

### Connection

```javascript
const ws = new WebSocket('wss://your-domain.com/ws');

ws.on('open', () => {
  // Send authentication
  ws.send(JSON.stringify({
    type: 'auth',
    token: 'your_access_token'
  }));
});

ws.on('message', (data) => {
  const message = JSON.parse(data);
  console.log('Received:', message);
});
```

### Subscription Events

| Event | Description |
|-------|-------------|
| `subscription.created` | New subscription |
| `subscription.renewed` | Subscription renewed |
| `subscription.expired` | Subscription expired |
| `user.registered` | New user registered |
| `partner.commission` | Commission received |
| `monitoring.alert` | Server alert |

### Sending Commands

```javascript
// Subscribe to updates
ws.send(JSON.stringify({
  type: 'subscribe',
  channels: ['subscriptions', 'monitoring']
}));

// Get real-time stats
ws.send(JSON.stringify({
  type: 'get_stats'
}));
```

## ❌ Error Codes

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `UNAUTHORIZED` | 401 | Invalid or missing token |
| `FORBIDDEN` | 403 | Insufficient permissions |
| `NOT_FOUND` | 404 | Resource not found |
| `VALIDATION_ERROR` | 400 | Invalid input data |
| `RATE_LIMIT` | 429 | Too many requests |
| `INTERNAL_ERROR` | 500 | Server error |
| `BAD_REQUEST` | 400 | Invalid request |

## 📝 Rate Limiting

| Endpoint | Requests | Window |
|----------|----------|--------|
| Auth | 10 | per minute |
| API (general) | 100 | per minute |
| Analytics | 30 | per minute |
| WebSocket | Unlimited | - |

## 🔒 Security Headers

All responses include:

```
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
X-XSS-Protection: 1; mode=block
Strict-Transport-Security: max-age=31536000; includeSubDomains
```

## 📚 API Versioning

Current API version: `v1`

Include version in requests:

```
GET /api/v1/users
```

## 🧪 Testing

### Sandbox Environment

For testing, use:

```
https://sandbox.rezeis.local/api
```

### Test Credentials

| Role | Username | Password |
|------|----------|----------|
| Super Admin | test_admin | test_pass123 |
| Partner | test_partner | test_pass123 |
| User | test_user | test_pass123 |