@echo off
chcp 65001 >nul
cd /d "%~dp0"

if exist "%~dp0.venv\Scripts\python.exe" (
    set "PYTHON=%~dp0.venv\Scripts\python.exe"
) else (
    set "PYTHON=python"
)

echo ====================================
echo  한국 주식 TOP 30 대시보드
echo  %date% %time%
echo ====================================
echo.

set /p update_choice="데이터를 새로 받아올까요? (Y/N, 기본 Y): "
if /i "%update_choice%"=="N" goto skip_update

echo.
echo [1/2] 데이터 업데이트 중...
echo --------------------------------
"%PYTHON%" src\fetch_data.py
if errorlevel 1 (
    echo.
    echo [경고] 데이터 업데이트 중 오류가 발생했습니다.
    echo 기존 data.json으로 계속 진행합니다.
    echo.
    timeout /t 3 >nul
)

:skip_update
echo.
echo [2/2] 로컬 서버 시작
echo --------------------------------
echo  URL : http://localhost:8000/
echo  종료: 이 창에서 Ctrl+C 또는 창 닫기
echo --------------------------------
echo.

timeout /t 1 >nul
start "" "http://localhost:8000/"

"%PYTHON%" src\server.py
