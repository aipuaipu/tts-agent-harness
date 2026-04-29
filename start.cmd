@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" -OpenBrowser %*
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo Startup failed! Please check the error above.
    pause
    exit /b %ERRORLEVEL%
)
echo.
echo All background services started. You can now close this window.
pause
