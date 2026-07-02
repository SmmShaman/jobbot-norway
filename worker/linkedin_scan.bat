@echo off
cd /d C:\Users\stuar\Projects\Jobbot-NO\worker
call venv\Scripts\activate
python linkedin_daemon.py --delay 30
