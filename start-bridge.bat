@echo off
rem LazyLord - start the local bridge (ws://localhost:7878, loopback only).
rem Keep this window open while transferring; close it to stop the bridge.
title LazyLord bridge - ws://localhost:7878
cd /d "%~dp0"
if not exist "packages\bridge\dist\server.js" (
  echo The bridge is not built yet. Run install.bat first.
  pause
  exit /b 1
)
echo LazyLord bridge - keep this window open while you transfer. Close it to stop.
echo.
node "packages\bridge\dist\server.js"
echo.
echo The bridge stopped. If it says the port is in use, another bridge window is already running.
pause
