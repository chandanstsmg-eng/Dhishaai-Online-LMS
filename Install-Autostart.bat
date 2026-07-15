@echo off
title DhishaAI LMS - Install Autostart (run once on the company server)
set "TARGET=%~dp0Run-Server-Forever.bat"
echo Setting the LMS server to start automatically when this PC starts...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$w=New-Object -ComObject WScript.Shell; $p=[Environment]::GetFolderPath('Startup')+'\DhishaAI LMS.lnk'; $s=$w.CreateShortcut($p); $s.TargetPath='%TARGET%'; $s.WorkingDirectory='%~dp0'; $s.WindowStyle=7; $s.Save()"
if %errorlevel% neq 0 (
  echo.
  echo Could not create the startup shortcut. You can add it manually:
  echo   1) Press Win+R, type  shell:startup  and press Enter.
  echo   2) Put a shortcut to Run-Server-Forever.bat in that folder.
  echo.
  pause
  exit /b
)
echo.
echo Done. From now on, whenever this PC starts (and someone logs in),
echo the LMS server starts on its own and stays running.
echo.
echo To UNDO: press Win+R, type  shell:startup  , and delete
echo the "DhishaAI LMS" shortcut in that folder.
echo.
pause
