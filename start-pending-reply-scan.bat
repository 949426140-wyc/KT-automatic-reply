@echo off
setlocal
set PATH=C:\Program Files\nodejs;%PATH%
set PENDING_REVIEW_MODE=true
set SEMI_AUTO_MODE=false
cd /d "%~dp0"
:loop
echo [%date% %time%] starting pending reply scanner >> pending-reply-scan.log
"C:\Program Files\nodejs\node.exe" auto-reply.js >> pending-reply-scan.log 2>&1
echo [%date% %time%] scanner exited; restart after 5 seconds >> pending-reply-scan.log
powershell -NoProfile -Command "Start-Sleep -Seconds 5" >nul 2>nul
goto loop
