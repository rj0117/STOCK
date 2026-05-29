@echo off
REM ============================================================
REM Non-interactive auto-update script for Windows Task Scheduler.
REM Runs fetch_data.py only. git commit + push is MANUAL (see notes).
REM
REM NOTE (2026-05-29): This file MUST stay ASCII-only. cmd.exe on Korean
REM Windows decodes batch files as cp949; UTF-8 Hangul bytes get misread.
REM Even with ASCII-only content, cmd.exe still aborts the batch right after
REM fetch_data.py finishes (verified across: chcp toggles, ASCII LOGFILE path,
REM ASCII-only batch, PowerShell wrapper for the Python call). Root cause not
REM pinned down. Symptoms: 'if errorlevel 1' block does not run, no echo
REM lines after the Python call reach LOGFILE or console, batch exits 1.
REM
REM Workaround: keep git push lines below but DO NOT rely on them. User
REM pushes manually with helper scripts/run.bat after reviewing changes.
REM ============================================================
cd /d "%~dp0"

if exist "%~dp0.venv\Scripts\python.exe" (
    set "PYTHON=%~dp0.venv\Scripts\python.exe"
) else (
    set "PYTHON=python"
)

REM Retry transcript fetch for old source=title fallback videos on PC IP
set SBSBIZ_RETRY_TITLE=1
REM Force Python stdout to UTF-8 (avoid cp949 encoding error on emoji / Hangul)
set PYTHONIOENCODING=utf-8

REM Log file (monthly rotation, outside repo on ASCII-only path)
if not exist "C:\STOCK_logs" mkdir "C:\STOCK_logs"
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM"') do set "LOG_YM=%%i"
set "LOGFILE=C:\STOCK_logs\cron-%LOG_YM%.log"

echo. >> "%LOGFILE%"
echo ============================================================ >> "%LOGFILE%"
echo [%DATE% %TIME%] START >> "%LOGFILE%"
echo [%DATE% %TIME%] fetch_data start (log: %LOGFILE%)

REM Run via PowerShell so file redirect is handled by .NET stream, not cmd.exe.
REM Direct cmd.exe redirect ('>> "%LOGFILE%" 2>&1') silently aborts the batch.
powershell -NoProfile -ExecutionPolicy Bypass -Command "& '%PYTHON%' 'src\fetch_data.py' *>> '%LOGFILE%'; exit $LASTEXITCODE"

REM ----- Lines below this point currently DO NOT run -----
REM cmd.exe aborts batch processing immediately after the powershell line above
REM (root cause unknown as of 2026-05-29). Push is performed manually by the
REM user. Keeping the original git lines in case the abort is fixed later.

if errorlevel 1 (
    echo [%DATE% %TIME%] END fetch=ERROR push=SKIP >> "%LOGFILE%"
    echo [%DATE% %TIME%] [ERROR] fetch_data failed - push skipped (see log)
    exit /b 1
)
echo [%DATE% %TIME%] fetch_data OK >> "%LOGFILE%"

git add public/data.json public/stocks.json public/sbsbiz.json public/flow_by_code.json public/buy_history.json public/backtest.json 2>> "%LOGFILE%"
git diff --cached --quiet
if errorlevel 1 (
    git commit -m "chore(data): local auto-update %DATE% %TIME%" >> "%LOGFILE%" 2>&1
    git push origin main >> "%LOGFILE%" 2>&1
    if errorlevel 1 (
        echo [%DATE% %TIME%] END fetch=OK push=ERROR >> "%LOGFILE%"
        echo [%DATE% %TIME%] [WARN] push failed - will retry next run
        exit /b 0
    )
    echo [%DATE% %TIME%] END fetch=OK push=OK >> "%LOGFILE%"
) else (
    echo [%DATE% %TIME%] END fetch=OK push=SKIP_NO_CHANGE >> "%LOGFILE%"
)

exit /b 0
