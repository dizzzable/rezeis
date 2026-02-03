# User Guide

This guide covers all aspects of using Rezeis effectively.

## 📋 Table of Contents

- [Getting Started](#getting-started)
- [Dashboard](#dashboard)
- [User Management](#user-management)
- [Subscription Management](#subscription-management)
- [Partner Program](#partner-program)
- [Promocodes](#promocodes)
- [Banners](#banners)
- [Analytics](#analytics)
- [Backups](#backups)
- [Telegram Mini App](#telegram-mini-app)

## 🚀 Getting Started

### Accessing the Panel

1. Open your browser and navigate to `https://your-domain.com`
2. Login with your admin credentials
3. You will be redirected to the dashboard

### First Time Setup

If no admin exists, you will see the setup page:

1. Enter desired username
2. Enter secure password
3. Enter your Telegram ID
4. Click "Create Super Admin"
5. Login with new credentials

## 📊 Dashboard

The dashboard provides an overview of your service status.

### Key Metrics

| Metric | Description |
|--------|-------------|
| **Total Users** | All registered users |
| **Active Subscriptions** | Currently valid subscriptions |
| **Revenue Today** | Today's payment volume |
| **Partner Earnings** | Today's partner commissions |

### Quick Actions

- **View Users** - Click to open user management
- **Create User** - Add new user manually
- **View Reports** - Access detailed analytics
- **Create Backup** - Backup database

## 👥 User Management

### Creating Users

1. Navigate to **Users** → **All Users**
2. Click **Add User**
3. Fill in user details:
   - Username
   - Email
   - Telegram ID (optional)
   - Initial plan (optional)
4. Click **Create User**

### User Details

Each user profile contains:

- **Profile Info** - Username, email, Telegram link
- **Subscriptions** - Active and expired subscriptions
- **Referral Code** - User's unique referral code
- **Partner Info** - Partner level and earnings
- **Activity Log** - User actions history

### Managing Users

| Action | Description |
|--------|-------------|
| **Edit** | Modify user details |
| **Suspend** | Temporarily disable access |
| **Delete** | Remove user (with confirmation) |
| **View Activity** | See user action history |

## 📦 Subscription Management

### Creating Subscriptions

1. Navigate to **Subscriptions** → **All Subscriptions**
2. Click **Create Subscription**
3. Select user
4. Choose plan
5. Set duration
6. Add discount (optional)
7. Click **Create**

### Subscription Status

| Status | Description |
|--------|-------------|
| **Active** | Valid subscription |
| **Expired** | Subscription ended |
| **Suspended** | Manually paused |
| **Trial** | Trial period |

### Renewing Subscriptions

1. Find subscription in list
2. Click **Renew**
3. Select new plan and duration
4. Confirm payment (if required)

### Multi-Subscription Support

Rezeis Panel supports multiple subscriptions per user:

- View all user subscriptions in one place
- Track subscription expirations
- Manage multiple VPN keys
- See combined usage statistics

## 🤝 Partner Program

### Partner Levels

| Level | Requirements | Commission Rate |
|-------|--------------|----------------|
| **Bronze** | 0-5 referrals | 5% |
| **Silver** | 6-20 referrals | 10% |
| **Gold** | 21-50 referrals | 15% |
| **Platinum** | 50+ referrals | 20% |

### Partner Dashboard

Partners have access to:

- **Earnings Overview** - Total and pending earnings
- **Referral Links** - Unique tracking links
- **Commission History** - Detailed breakdown
- **Withdrawal Requests** - Payout management

### Managing Partners

1. Navigate to **Partners**
2. View all partners
3. Click partner to see details
4. Adjust levels manually if needed

## 🎫 Promocodes

### Creating Promocodes

1. Navigate to **Promocodes**
2. Click **Create Promocode**
3. Fill in details:
   - **Code** - Unique promo code
   - **Discount Type** - Percentage or fixed amount
   - **Discount Value** - Amount of discount
   - **Usage Limit** - Max uses (optional)
   - **Expiration** - Valid until (optional)
   - **Plans** - Applicable plans (optional)
4. Click **Create**

### Promocode Types

| Type | Description |
|------|-------------|
| **Percentage** | Discount as % of price |
| **Fixed** | Fixed amount discount |
| **Trial** | Free trial period |
| **Special** | Custom discount rules |

### Activations Tracking

View which users activated promocodes:

1. Open promocode details
2. See **Activations** tab
3. View user, date, and discount applied

## 🖼️ Banners

### Creating Banners

1. Navigate to **Banners**
2. Click **Add Banner**
3. Fill in:
   - **Title** - Banner title
   - **Description** - Banner text
   - **Image** - Upload image
   - **Link** - Target URL
   - **Position** - Where to display
   - **Priority** - Display order
   - **Expiration** - When to hide
4. Click **Create**

### Banner Positions

| Position | Description |
|----------|-------------|
| **Header** | Top of the page |
| **Sidebar** | Side panel |
| **Footer** | Bottom of page |
| **Popup** | Modal popup |

## 📈 Analytics

### Dashboard Charts

View key metrics over time:

- **Revenue Chart** - Daily/monthly revenue
- **User Growth** - New user registrations
- **Subscription Trends** - Active subscriptions
- **Partner Earnings** - Commission payouts

### Reports

Generate detailed reports:

1. Navigate to **Analytics** → **Reports**
2. Select date range
3. Choose report type:
   - **User Report** - User activity
   - **Revenue Report** - Payment details
   - **Partner Report** - Commission summary
4. Click **Generate**
5. Export as CSV or Excel

### Exporting Data

1. Go to desired section
2. Click **Export**
3. Choose format:
   - **CSV** - Spreadsheet format
   - **Excel** - .xlsx format
   - **JSON** - Raw data

## 💾 Backups

### Creating Backups

1. Navigate to **Settings** → **Backups**
2. Click **Create Backup**
3. Select what to backup:
   - **Full** - Everything
   - **Users** - User data only
   - **Subscriptions** - Subscription data
   - **Settings** - System configuration
4. Click **Create**

### Restoring Backups

⚠️ **Warning**: Restoring will overwrite current data!

1. Go to **Backups**
2. Select backup to restore
3. Click **Restore**
4. Confirm action
5. Wait for restoration to complete

### Automated Backups

Configure automated backups in `.env`:

```env
BACKUP_ENABLED=true
BACKUP_INTERVAL_HOURS=24
BACKUP_TIME=03:00
BACKUP_MAX_KEEP=7
```

## 📱 Telegram Mini App

### Accessing Mini App

Users can access via:

1. **Telegram Bot** - Click inline button
2. **Direct Link** - `https://t.me/yourbot/miniapp`

### Features

- **Server List** - View available servers
- **My Subscription** - View current plan
- **Payment** - Purchase subscriptions
- **Profile** - Manage account
- **Support** - Contact admin

### Admin Setup

1. Create Telegram bot via @BotFather
2. Set `TELEGRAM_BOT_TOKEN` in environment
3. Configure Mini App URL
4. Test the integration

## 🔔 Notifications

### System Notifications

Users receive notifications for:

- Subscription expiration reminders
- Payment confirmations
- Partner commission updates
- Broadcast messages

### Broadcast Messages

Send mass notifications:

1. Navigate to **Notifications**
2. Click **Broadcast**
3. Select recipients:
   - **All Users**
   - **Active Subscribers**
   - **Partners Only**
   - **Custom Group**
4. Write message
5. Click **Send**

## ⚙️ Settings

### General Settings

| Setting | Description |
|---------|-------------|
| **Site Name** | Panel name |
| **Currency** | Payment currency |
| **Timezone** | Display timezone |
| **Language** | Default language |

### Payment Settings

| Setting | Description |
|---------|-------------|
| **Currency Symbol** | Currency symbol |
| **Tax Rate** | VAT/tax percentage |
| **Payment Methods** | Enabled gateways |

## 🆘 Support

### Common Issues

| Issue | Solution |
|-------|----------|
| Can't login | Check credentials, clear cache |
| Payment failed | Verify gateway settings |
| User not found | Check Telegram ID linkage |
| Backup failed | Check disk space |

### Getting Help

- Check [FAQ](https://github.com/dizzable/rezeis/wiki/FAQ)
- Search [Issues](https://github.com/dizzable/rezeis/issues)
- Create new issue for bugs
- Contact support@rezeis.local