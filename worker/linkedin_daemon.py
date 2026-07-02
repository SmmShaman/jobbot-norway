"""
Standalone LinkedIn scanner — runs once after PC startup.
No Skyvern dependency. Sends Telegram notification on start/finish.
Full pipeline: scan → analyze (Gemini) → auto-søknad → notify.

Usage:
    python linkedin_daemon.py                # scan now
    python linkedin_daemon.py --once         # same as above (alias)
    python linkedin_daemon.py --delay 30     # wait 30 min, then scan
"""

import asyncio
import os
import sys
import httpx
from datetime import datetime, timezone
from dotenv import load_dotenv

load_dotenv()

TELEGRAM_BOT_TOKEN = os.getenv('TELEGRAM_BOT_TOKEN', '')


async def notify_telegram(text: str):
    """Send notification to all LinkedIn-enabled users via Telegram."""
    if not TELEGRAM_BOT_TOKEN:
        return
    from supabase import create_client
    supabase = create_client(os.getenv('SUPABASE_URL'), os.getenv('SUPABASE_SERVICE_KEY'))
    users = supabase.table('user_settings') \
        .select('telegram_chat_id') \
        .eq('linkedin_scan_enabled', True) \
        .not_.is_('telegram_chat_id', 'null').execute()

    async with httpx.AsyncClient() as client:
        for u in (users.data or []):
            chat_id = u.get('telegram_chat_id')
            if chat_id:
                try:
                    await client.post(
                        f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage",
                        json={"chat_id": chat_id, "text": text, "parse_mode": "HTML"},
                        timeout=10.0
                    )
                except Exception:
                    pass


async def run_analysis():
    """Run Gemini analysis on all unanalyzed jobs."""
    from analyze_worker import main as analyze_main
    print(f"\n🔬 Running Gemini analysis on unanalyzed jobs...")
    try:
        await analyze_main(limit=50)
    except Exception as e:
        print(f"⚠️ Analysis error: {e}")


async def run_scan():
    from linkedin_scraper import scan_all_users
    ts = datetime.now(timezone.utc).strftime('%H:%M UTC')

    await notify_telegram(f"🟣 <b>LinkedIn сканування почалося</b>\n🕐 {ts}\n💻 {os.environ.get('COMPUTERNAME', 'dev-pc')}")

    print(f"🟣 LinkedIn scan started at {ts}")
    try:
        await scan_all_users()
        print(f"🟣 LinkedIn scan finished")

        # Run analysis on newly added jobs
        await run_analysis()

        await notify_telegram(f"🟣 <b>LinkedIn сканування + аналіз завершено</b> ✅")
    except Exception as e:
        print(f"⚠️ Scan error: {e}")
        await notify_telegram(f"🟣 <b>LinkedIn сканування — помилка</b>\n⚠️ {e}")


async def main():
    # Parse --delay N (minutes)
    delay_min = 0
    if '--delay' in sys.argv:
        idx = sys.argv.index('--delay')
        if idx + 1 < len(sys.argv):
            delay_min = int(sys.argv[idx + 1])

    if delay_min > 0:
        print(f"💤 Waiting {delay_min} min before scanning...")
        await asyncio.sleep(delay_min * 60)

    await run_scan()


if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n🟣 Cancelled.")
