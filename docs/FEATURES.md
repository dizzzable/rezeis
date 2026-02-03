# Features Documentation

Detailed documentation of all Rezeis features.

## 📋 Table of Contents

- [Multi-Subscription System](#multi-subscription-system)
- [Remnawave Integration](#remnawave-integration)
- [Telegram Mini App](#telegram-mini-app)
- [WebSocket Monitoring](#websocket-monitoring)
- [Partner Program](#partner-program)
- [Trial System](#trial-system)
- [Referral System](#referral-system)
- [Promocode System](#promocode-system)
- [Notification System](#notification-system)
- [Backup System](#backup-system)

## 🔄 Multi-Subscription System

### Overview

The multi-subscription system allows users to manage multiple VPN subscriptions from a single account. This is particularly useful for users who need access to different servers or want to share subscriptions with family members.

### Key Features

| Feature | Description |
|---------|-------------|
| **Multiple Subscriptions** | Unlimited subscriptions per user |
| **Unified Dashboard** | View all subscriptions in one place |
| **Combined Usage** | Aggregate bandwidth and usage statistics |
| **Easy Management** | Renew, upgrade, or cancel any subscription |
| **Expiry Tracking** | Visual indicators for expiring subscriptions |

### How It Works

1. **Subscription Creation**
   - Admin creates subscription linked to user
   - Select plan, duration, and apply discounts
   - System generates unique VPN configuration

2. **Subscription Linking**
   - Multiple subscriptions can be linked to Remnawave accounts
   - Automatic synchronization of status
   - Unified billing and expiration

3. **Usage Aggregation**
   - Bandwidth usage across all subscriptions
   - Connection history consolidated
   - Combined statistics for reporting

### Database Schema

```
User
├── Subscriptions[]
│   ├── VPNConfiguration
│   ├── Plan
│   └── StatusHistory[]
```

## 🌊 Remnawave Integration

### Overview

Seamless integration with [Remnawave VPN Panel](https://remnawave.com) for managing VPN services, users, and subscriptions.

### Integration Features

| Feature | Description |
|---------|-------------|
| **User Sync** | Automatic synchronization of users |
| **Subscription Sync** | Real-time subscription status |
| **Webhook Support** | Event-driven updates |
| **API Integration** | Full REST API access |
| **Caddy Token** | Advanced configuration access |

### Configuration

```env
REMNAWAVE_HOST=remnawave
REMNAWAVE_PORT=3000
REMNAWAVE_TOKEN=your_api_token
REMNAWAVE_WEBHOOK_SECRET=webhook_secret
REMNAWAVE_SYNC_INTERVAL_MINUTES=5
REMNAWAVE_SYNC_ENABLED=true
```

### Sync Process

1. **Initial Sync**
   - Fetch all existing users from Remnawave
   - Match with local users by Telegram ID or email
   - Create links between accounts

2. **Real-time Updates**
   - Webhook receives Remnawave events
   - Updates local database
   - Notifies connected clients

3. **Periodic Sync**
   - Scheduled sync every 5 minutes
   - Checks for missed events
   - Reconciles any discrepancies

### Supported Operations

| Operation | Description |
|-----------|-------------|
| `user.created` | New user in Remnawave |
| `user.updated` | User data changed |
| `subscription.created` | New subscription |
| `subscription.expired` | Subscription ended |
| `traffic.used` | Bandwidth update |

## 📱 Telegram Mini App

### Overview

A mobile-first web application accessible directly through Telegram, providing users with convenient access to their subscriptions and account management.

### Features

| Feature | Description |
|---------|-------------|
| **Server List** | Browse available VPN servers |
| **My Subscription** | View current plan and expiry |
| **Quick Actions** | Renew, upgrade, purchase |
| **Profile Management** | Update account settings |
| **Support** | Contact admin |
| **Push Notifications** | Important updates via Telegram |

### Access Methods

1. **Bot Menu Button**
   ```
   1. Open Telegram bot
   2. Click menu button (⋮)
   3. Select "Open Panel"
   ```

2. **Deep Link**
   ```
   https://t.me/yourbot/miniapp
   ```

3. **Inline Button**
   ```
   [Open Mini App](https://t.me/yourbot/miniapp)
   ```

### Mini App Screens

| Screen | Route | Description |
|--------|-------|-------------|
| **Home** | `/` | Dashboard with quick stats |
| **Servers** | `/servers` | Available VPN servers |
| **Subscription** | `/subscription` | Current subscription details |
| **Purchase** | `/purchase` | Plan selection and payment |
| **Profile** | `/profile` | User settings |
| **Help** | `/help` | Support information |

### Setup

```env
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_MINI_APP_URL=https://your-domain.com/miniapp/
```

## 📡 WebSocket Monitoring

### Overview

Real-time server monitoring through WebSocket connections, providing live updates on server status, resource usage, and alerts.

### Monitored Metrics

| Metric | Description |
|--------|-------------|
| **CPU Usage** | Current processor load |
| **Memory Usage** | RAM consumption |
| **Bandwidth** | In/out traffic volume |
| **Connections** | Active user connections |
| **Server Status** | Online/offline state |

### WebSocket Events

```javascript
// Subscribe to monitoring updates
ws.send({
  type: 'subscribe',
  channels: ['monitoring']
});

// Receive real-time updates
ws.on('message', (data) => {
  if (data.type === 'monitoring.update') {
    console.log(data.payload);
  }
});
```

### Alert System

Configure alerts for:

- CPU usage > 80%
- Memory usage > 90%
- Bandwidth exceeded
- Server offline

```typescript
interface AlertConfig {
  metric: 'cpu' | 'memory' | 'bandwidth' | 'status';
  threshold: number;
  operator: '>' | '<' | '>=' | '<=';
  enabled: boolean;
  notification: 'telegram' | 'email' | 'both';
}
```

## 🤝 Partner Program

### Overview

Multi-level partnership system with commission tracking and automatic payouts.

### Partner Levels

| Level | Referrals Required | Commission Rate |
|-------|-------------------|-----------------|
| Bronze | 0-5 | 5% |
| Silver | 6-20 | 10% |
| Gold | 21-50 | 15% |
| Platinum | 50+ | 20% |

### Commission Types

| Type | Description |
|------|-------------|
| **Direct** | Commission from direct referrals |
| **Override** | Commission from sub-partners |
| **Override Bonus** | Bonus for reaching levels |

### Earning Structure

```
Referral (10%) → Partner (10%) → Senior Partner (5%)
```

### Partner Dashboard

- Total earnings overview
- Pending vs. paid commissions
- Referral tracking
- Payout history
- Performance analytics

### Payout Options

| Method | Minimum | Processing Time |
|--------|---------|------------------|
| Crypto (USDT) | $50 | 24 hours |
| Bank Transfer | $100 | 3-5 days |
| Service Credit | $0 | Instant |

## 🎁 Trial System

### Overview

Free trial system allowing new users to experience the service before purchasing.

### Trial Configuration

| Setting | Description |
|---------|-------------|
| **Duration** | Trial length in days |
| **Limit** | Max trials per user |
| **Features** | Included plan features |
| **Bandwidth** | Trial data limit |

### Trial Flow

1. User registers
2. System checks trial eligibility
3. Trial subscription created
4. User accesses VPN service
5. Trial expires → Upgrade prompt

### Trial Restrictions

- Cannot create referral links
- Cannot access partner features
- Limited server selection
- Data cap enforcement

## 📊 Referral System

### Overview

User referral system with unique codes and rewards.

### How It Works

1. **Get Referral Code**
   - Each user has unique code
   - Code format: `USER123`

2. **Share Code**
   - Share via link or code
   - Trackable in analytics

3. **Friend Signs Up**
   - Uses referral code
   - Gets signup bonus

4. **Rewards**
   - Referral gets discount
   - Referrer earns commission

### Referral Rewards

| Action | Referrer Reward | Referee Reward |
|--------|----------------|----------------|
| Signup | - | 10% off first month |
| First Purchase | 1 month free | - |
| Subscription Renewal | 5% recurring | - |

### Tracking

- Real-time referral tracking
- Conversion analytics
- Reward history
- Fraud detection

## 🎫 Promocode System

### Overview

Flexible promocode system for discounts and promotions.

### Promocode Types

| Type | Description | Example |
|------|-------------|---------|
| **Percentage** | % discount | 20% off |
| **Fixed** | Fixed amount | $10 off |
| **Trial** | Free trial | 7 days free |
| **Special** | Custom rules | VIP access |

### Configuration Options

| Option | Description |
|--------|-------------|
| **Usage Limit** | Max total uses |
| **Per User** | Uses per user |
| **Expiration** | Valid until date |
| **Plans** | Applicable plans |
| **Minimum Order** | Min purchase amount |
| **New Users Only** | First purchase only |

### Activation Tracking

- Track each promocode activation
- User who used it
- Subscription applied to
- Discount amount
- Date and time

## 🔔 Notification System

### Overview

Multi-channel notification system for user engagement.

### Notification Channels

| Channel | Description |
|---------|-------------|
| **Telegram** | Direct bot messages |
| **Email** | Email notifications |
| **In-App** | Panel notifications |
| **Push** | Browser push notifications |

### Notification Types

| Type | Trigger | Channel |
|------|---------|---------|
| **Expiration** | 7 days before expiry | Telegram, Email |
| **Payment** | Successful payment | Telegram, In-App |
| **Broadcast** | Admin message | All channels |
| **Alert** | Monitoring threshold | Telegram, Email |

### Broadcast Feature

Send messages to:

- All users
- Active subscribers only
- Partners only
- Specific user groups

## 💾 Backup System

### Overview

Automated and manual backup system for data protection.

### Backup Types

| Type | Description |
|------|-------------|
| **Full** | Complete database dump |
| **Incremental** | Changes since last backup |
| **Selective** | Specific tables |

### Scheduled Backups

```env
BACKUP_ENABLED=true
BACKUP_INTERVAL_HOURS=24
BACKUP_TIME=03:00
BACKUP_MAX_KEEP=7
BACKUP_COMPRESSION=true
```

### Backup Storage

| Method | Description |
|--------|-------------|
| **Local** | Server filesystem |
| **Telegram** | Send to Telegram channel |
| **S3** | Amazon S3 compatible storage |

### Restore Process

1. Select backup file
2. Choose restore options
3. Confirm action
4. System restores data
5. Verify integrity

### Backup Contents

| Table | Included |
|-------|----------|
| Users | ✓ |
| Subscriptions | ✓ |
| Promocodes | ✓ |
| Partners | ✓ |
| Settings | ✓ |
| Statistics | ✗ |

## 🔐 Security Features

### Authentication

- JWT-based authentication
- Refresh token rotation
- Session management
- 2FA support (coming soon)

### Authorization

- Role-based access control
- Permission system
- Super admin, admin, partner roles

### Data Protection

- Encryption at rest
- SSL/TLS encryption
- Rate limiting
- Input sanitization

## 📈 Analytics

### Available Reports

| Report | Description |
|--------|-------------|
| **Revenue** | Income and payments |
| **Users** | Registration and activity |
| **Subscriptions** | Creation and renewal |
| **Partners** | Commission payouts |
| **Traffic** | Bandwidth usage |

### Export Formats

- CSV
- Excel (XLSX)
- JSON
- PDF (coming soon)

### Real-time Stats

- Dashboard KPIs
- Live traffic monitoring
- Active user count
- Revenue today