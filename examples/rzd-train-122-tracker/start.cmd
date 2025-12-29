@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found.
  echo Install Node.js 18 or newer and run start.cmd again.
  pause
  exit /b 1
)

echo Starting RZD Multi-Train Tracker...
start "" "http://127.0.0.1:8788"
node server.mjs

echo.
echo Server stopped.
pause
