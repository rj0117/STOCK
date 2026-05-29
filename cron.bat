@echo off
REM ============================================================
REM Windows 작업 스케줄러용 비대화형 자동 갱신 스크립트.
REM run.bat 은 사용자 prompt 가 있어서 스케줄러에서 멈춤. 이 파일은 prompt 없음.
REM
REM 동작:
REM 1) fetch_data.py 실행 (SBS Biz 자막 재시도 = SBSBIZ_RETRY_TITLE 활성)
REM 2) 변경된 데이터 파일이 있으면 git commit + push
REM ============================================================
chcp 65001 >nul
cd /d "%~dp0"

if exist "%~dp0.venv\Scripts\python.exe" (
    set "PYTHON=%~dp0.venv\Scripts\python.exe"
) else (
    set "PYTHON=python"
)

REM 옛 source=title 폴백 영상의 자막을 PC IP 로 재시도
set SBSBIZ_RETRY_TITLE=1
REM Python stdout 을 UTF-8 로 (이모지/한글 출력 시 cp949 인코딩 에러 방지)
set PYTHONIOENCODING=utf-8

REM 로그 파일 (월별 로테이션, *.log 는 gitignore 됨)
if not exist "%~dp0logs" mkdir "%~dp0logs"
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM"') do set "LOG_YM=%%i"
set "LOGFILE=%~dp0logs\cron-%LOG_YM%.log"

echo. >> "%LOGFILE%"
echo ============================================================ >> "%LOGFILE%"
echo [%DATE% %TIME%] START >> "%LOGFILE%"
echo [%DATE% %TIME%] fetch_data 시작 (log: %LOGFILE%)

"%PYTHON%" src\fetch_data.py >> "%LOGFILE%" 2>&1
if errorlevel 1 (
    echo [%DATE% %TIME%] END fetch=ERROR push=SKIP >> "%LOGFILE%"
    echo [%DATE% %TIME%] [ERROR] fetch_data 실패 - push 생략 (자세한 내용은 로그)
    exit /b 1
)
echo [%DATE% %TIME%] fetch_data OK >> "%LOGFILE%"

REM 변경된 데이터 파일만 add (있을 때)
git add public/data.json public/stocks.json public/sbsbiz.json public/flow_by_code.json public/buy_history.json public/backtest.json 2>> "%LOGFILE%"

REM 스테이지에 변경 있는지 확인
git diff --cached --quiet
if errorlevel 1 (
    git commit -m "chore(data): local auto-update %DATE% %TIME%" >> "%LOGFILE%" 2>&1
    git push origin main >> "%LOGFILE%" 2>&1
    if errorlevel 1 (
        echo [%DATE% %TIME%] END fetch=OK push=ERROR >> "%LOGFILE%"
        echo [%DATE% %TIME%] [WARN] push 실패 - 다음 실행에서 재시도
        exit /b 0
    )
    echo [%DATE% %TIME%] END fetch=OK push=OK >> "%LOGFILE%"
    echo [%DATE% %TIME%] push 성공
) else (
    echo [%DATE% %TIME%] END fetch=OK push=SKIP_NO_CHANGE >> "%LOGFILE%"
    echo [%DATE% %TIME%] 변경 없음 - push 생략
)

exit /b 0
