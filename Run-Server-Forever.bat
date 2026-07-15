@echo off
title DhishaAI LMS Server (auto-restart)
cd /d "%~dp0server"
echo ================================================================
echo   DhishaAI LMS - running on port 9000
echo   This window keeps the website online. Keep it OPEN.
echo   If the server ever stops, it restarts automatically.
echo   The Wi-Fi address to share is printed below.
echo ================================================================
:loop
echo.
echo [%date% %time%] Starting server...
node index.js
echo.
echo [%date% %time%] Server stopped - restarting in 3 seconds.
echo (To stop for good, just close this window.)
timeout /t 3 /nobreak >nul
goto loop
