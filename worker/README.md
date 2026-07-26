# JobBot Worker - Skyvern Integration

Python workers for automated job application processing using Skyvern browser automation.

## Prerequisites

1. **Python 3.8+**
2. **Skyvern** running locally (Docker recommended)
3. **Supabase** project with configured tables

## Setup

### 1. Install Dependencies

```bash
cd worker
pip3 install -r requirements.txt
```

### 2. Start Skyvern (Docker)

If Skyvern is not running:

```bash
# Using Docker Compose (recommended)
docker compose up -d

# Or using Skyvern CLI
pip install skyvern
skyvern quickstart
```

Verify Skyvern is running:
- API: http://localhost:8000
- UI: http://localhost:8080

### 3. Get Skyvern API Key

1. Open Skyvern UI: http://localhost:8080
2. Navigate to **Settings** or **API Keys** section
3. Generate or copy your API key
4. Save it to your `.env` file

### 4. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with your credentials:

```env
# Required - Supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your-service-role-key

# Required - Skyvern
SKYVERN_API_URL=http://localhost:8000
SKYVERN_API_KEY=your-skyvern-api-key

# Required for FINN Enkel Søknad - Your FINN.no login
FINN_EMAIL=your-finn-email@example.com
FINN_PASSWORD=your-finn-password

# Optional - Telegram notifications
TELEGRAM_BOT_TOKEN=your-telegram-bot-token
```

**Important:** Without `FINN_EMAIL` and `FINN_PASSWORD`, FINN Enkel Søknad auto-apply will not work!

## Scripts

### `auto_apply.py` - Main Application Worker

Monitors database for applications with `status: 'sending'` and uses Skyvern to fill out job application forms.

```bash
python3 auto_apply.py
```

Features:
- Fetches user knowledge base and CV profile
- Generates signed resume URLs
- Sends tasks to Skyvern with form-filling instructions
- Updates application status in database

### `extract_apply_url.py` - URL Extractor

Clicks on "Sok her" (FINN) or "Ga til soknad" (NAV) buttons to extract external application URLs.

```bash
# Single URL extraction
python3 extract_apply_url.py "https://www.finn.no/job/fulltime/ad.html?finnkode=12345"

# Daemon mode (listens for jobs in DB)
python3 extract_apply_url.py --daemon
```

## Troubleshooting

### "Invalid credentials" Error

Make sure `SKYVERN_API_KEY` is set in your `.env` file. Get the key from Skyvern UI settings.

### Connection Refused

Ensure Skyvern Docker containers are running:

```bash
docker ps | grep skyvern
```

Expected containers:
- `skyvern-1` (API on port 8000)
- `skyvern-ui-1` (UI on port 8080)

### Skyvern Task Fails

1. Check Skyvern UI for task logs
2. Verify the job URL is accessible
3. Check if cookie popups need handling
