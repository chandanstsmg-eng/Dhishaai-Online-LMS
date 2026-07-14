@echo off
title DhishaAI LMS - Firewall Setup (one time)
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo.
  echo   This must run as Administrator.
  echo   Right-click this file  ->  "Run as administrator".
  echo.
  pause
  exit /b
)
echo Adding a firewall rule so other devices on your Wi-Fi can reach port 9000...
netsh advfirewall firewall delete rule name="DhishaAI LMS 9000" >nul 2>&1
netsh advfirewall firewall add rule name="DhishaAI LMS 9000" dir=in action=allow protocol=TCP localport=9000 profile=any
echo.
echo Done. Port 9000 is now open. You only need to run this once.
echo Now start the server with Start-LMS.bat and share the Wi-Fi address it prints.
echo.
pause
