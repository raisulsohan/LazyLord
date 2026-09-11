@echo off
rem LazyLord - run the bridge on its own (ws://localhost:7878, loopback only).
rem Not needed in normal use: the LazyLord panel in Photoshop, Illustrator or
rem After Effects runs the bridge itself. This is for troubleshooting, or for
rem sending between Figma files with no Adobe app open.
title LazyLord bridge - ws://localhost:7878
cd /d "%~dp0"
if not exist "packages\bridge\dist\server.js" (
  echo The bridge is not built yet. Run install.bat first.
  pause
  exit /b 1
)
echo LazyLord bridge (stand-alone). Normally the LazyLord panel runs it for you.
echo Close this window to stop it.
echo.
node "packages\bridge\dist\server.js"
echo.
pause
