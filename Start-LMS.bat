@echo off
title DhishaAI LMS Server
cd /d "%~dp0server"
echo ================================================================
echo   DhishaAI LMS  -  starting server on port 9000
echo   Keep this window OPEN. Closing it stops the server.
echo   The Wi-Fi address to share is printed below.
echo ================================================================
echo.
node index.js
echo.
echo Server stopped. Press any key to close this window.
pause >nul
