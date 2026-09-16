@echo off
rem LazyLord - installs the panel for Photoshop, Illustrator and After Effects.
rem The .zxp next to this file is signed, so nothing else has to be installed
rem first: no Node.js, no extension manager, no debug switch.

setlocal EnableExtensions
title Install LazyLord
cd /d "%~dp0"

set "EXT_ROOT=%APPDATA%\Adobe\CEP\extensions"
set "DEST=%EXT_ROOT%\com.lazylord.panel"

echo ============================================================
echo   LazyLord - install
echo   Photoshop  .  Illustrator  .  After Effects  .  Figma
echo ============================================================
echo.
echo Close Photoshop, Illustrator and After Effects before going on -
echo a running app holds on to the old panel's files.
echo.
pause
echo.

set "ZXP="
for %%f in ("*.zxp") do set "ZXP=%%~ff"
if not defined ZXP (
  echo [!] There is no LazyLord .zxp file next to this one.
  echo     Unzip the whole download first, then run this from inside that folder.
  goto :fail
)

echo Installing %ZXP%
echo         to %DEST%
echo.

if not exist "%EXT_ROOT%" mkdir "%EXT_ROOT%"
call :remove_panel
if exist "%DEST%" (
  echo [!] The old LazyLord panel could not be removed.
  echo     Close Photoshop, Illustrator and After Effects and run this again.
  goto :fail
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory('%ZXP%', '%DEST%')"
if not exist "%DEST%\CSXS\manifest.xml" (
  echo [!] The panel did not unpack. Please send the messages above to the developer.
  goto :fail
)

echo.
echo ============================================================
echo   Installed.
echo ============================================================
echo.
echo   Open it in each app:
echo     Photoshop      Window - Extensions (legacy) - LazyLord
echo     Illustrator    Window - Extensions - LazyLord
echo     After Effects  Window - Extensions - LazyLord
echo.
echo   The dot turns green when the panel is ready. Keep one LazyLord
echo   panel open and Figma can reach it - there is no separate bridge.
echo.
echo   Figma: run "2 - Add the Figma plugin.bat" next. Skip it if you only
echo   move things between the Adobe apps.
echo.
echo   If a panel opens blank, run "Fix a blank panel.bat" and restart
echo   the app.
echo.
goto :end

rem ================================================================ helpers

:remove_panel
if not exist "%DEST%" exit /b 0
rem A junction - what the developer install.bat makes - is removed with a plain
rem rmdir, which never touches the folder it points at.
dir /a:l /b "%EXT_ROOT%" 2>nul | findstr /i /x "com.lazylord.panel" >nul
if not errorlevel 1 (
  rmdir "%DEST%"
) else (
  rmdir /s /q "%DEST%"
)
exit /b 0

:fail
echo.
echo Nothing was installed. Fix the problem above and run this again.

:end
echo.
pause
