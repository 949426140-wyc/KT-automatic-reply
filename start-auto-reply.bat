@echo off
setlocal
set PATH=C:\Program Files\nodejs;%PATH%
cd /d "%~dp0"
:loop
if exist "%~dp0auto-reply.disabled" (
  echo [%date% %time%] auto-reply.disabled found; service remains off >> auto-reply.log
  exit /b 0
)
echo [%date% %time%] starting Kutai DingTalk auto reply service >> auto-reply.log
"C:\Program Files\nodejs\node.exe" auto-reply.js >> auto-reply.log 2>&1
echo [%date% %time%] process exited; restart after 5 seconds >> auto-reply.log
powershell -NoProfile -Command "Start-Sleep -Seconds 5" >nul 2>nul
goto loop
