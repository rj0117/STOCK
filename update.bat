@echo off
chcp 65001 >nul
cd /d "%~dp0"

if exist "%~dp0.venv\Scripts\python.exe" (
    set "PYTHON=%~dp0.venv\Scripts\python.exe"
) else (
    set "PYTHON=python"
)

echo ====================================
echo 한국 주식 TOP 30 데이터 업데이트
echo %date% %time%
echo ====================================
echo.

"%PYTHON%" src\fetch_data.py

echo.
echo 업데이트 완료!
pause