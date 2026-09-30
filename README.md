# 🔐 VPN Bot

- 🧑‍💻 A Telegram bot to manage VPN/VLESS services.
- 🚀 Integrated with WizardXray API for automatic service provisioning.
- 🛠️ Admin panel in Telegram group for manual provisioning, payments, and overrides.
- ☁️ Uses MongoDB and Redis to manage user sessions and service data.

## 🎯 Main Goal
The main goal of this project is to simplify the process of managing and delivering VPN (VLESS) services through Telegram.
It automates user service provisioning, balance management, and integrates fallback manual tools for admins — all accessible within Telegram, making it ideal for small teams or individuals running VPN businesses.
## ⚙️ Features

- Accepts plan orders, checks user balance, calls WizardXray API to create VPN services.
- Automatically deducts user balance.
- Stores service details (`username`, `links`, `expire_date`, `usage`, etc.) in MongoDB.
- Fallback manual flow: Admin group can confirm or reject payment, send configs, and manually register services.
- Redis-backed session-based flows for OTP, confirmation steps, manual processes, etc.
##  🔧 Technical Stack

- Node.js (v16+), Express or Telegram Bot API using `node-telegram-bot-api`
- MongoDB (Atlas or local)
- Redis (Cloud or local) for session & state management
- Axios for HTTP requests to WizardXray API
- Moment-jalaali for date formatting (optional)
## 📁 Environment Variables

Create a `.env` file with the following variables:

```env
BOT_TOKEN=your_telegram_bot_token
VPN_API_KEY=your_wizardxray_api_key
MONGO_URL=your_mongodb_connection_string
NOW_PAYMENTS_API_KEY=your_nowpayments_api_key
CARD_NUMBER=your_sheba_or_card_number
GROUP_ID=your_admin_group_id
ADMINS=comma_separated_admin_ids
WIZARD_API_URL=https://robot.wizardxray.shop/bot/api/v1
REDIS_HOST=your_redis_host
REDIS_PORT=your_redis_port
REDIS_PASSWORD=your_redis_password

# HooshPay Card-to-Card Payment Gateway
HOOSHPAY_API_KEY=your_hooshpay_api_key
HOOSHPAY_WEBHOOK_SECRET=your_hooshpay_webhook_secret
WEBHOOK_BASE_URL=https://your-server-domain.com
PORT=3000
```

### HooshPay Environment Variables

| Variable | Description |
|---|---|
| `HOOSHPAY_API_KEY` | Your HooshPay API key (from the HooshPay dashboard → Development). Format: `hp_live_xxx` |
| `HOOSHPAY_WEBHOOK_SECRET` | Your HooshPay webhook secret used for HMAC-SHA256 signature verification |
| `WEBHOOK_BASE_URL` | Your server's public HTTPS URL (e.g., `https://bot.example.com`). The webhook endpoint is at `/api/hooshpay/webhook` |
| `PORT` | Express server port (default: 3000) |
