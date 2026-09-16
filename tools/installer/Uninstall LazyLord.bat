@echo off
rem LazyLord - removes the Adobe panel. Nothing else is left behind: LazyLord
rem writes no registry keys of its own and keeps its settings inside the panel.

setlocal EnableExtensions
title Uninstall LazyLord
set "EXT_ROOT=%APPDATA%\Adobe\CEP\extensions"
set "DEST=%EXT_ROOT%\com.lazylord.panel"

echo Removing the LazyLord panel...
echo Close Photoshop, Illustrator and After Effects first.
echo.
pause

if not exist "%DEST%" (
  echo It was not installed.
  goto :end
)

dir /a:l /b "%EXT_ROOT%" 2>nul | findstr /i /x "com.lazylord.panel" >nul
if not errorlevel 1 (rmdir "%DEST%") else (rmdir /s /q "%DEST%")

if exist "%DEST%" (
  echo [!] Could not remove it - an Adobe app is probably still open.
) else (
  echo Removed.
  echo In Figma, take the plugin out with Plugins - Development - Manage plugins in development.
)

:end
echo.
pause
