@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js не найден.
  echo Установите Node.js 18 или новее.
  echo.
  pause
  exit /b 1
)

start "" "http://127.0.0.1:8788"
node server.mjs

echo.
pause
