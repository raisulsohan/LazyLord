@echo off
rem LazyLord - one-step install for live testing on Windows.
rem   install.bat              build everything and install the Adobe panel
rem   install.bat /uninstall   remove the Adobe panel link
rem Nothing needs to be left running: the LazyLord panel runs the bridge itself.
rem Figma needs one manual click (Import plugin from manifest); this script
rem prepares everything else and tells you exactly what to click.

setlocal EnableExtensions
title LazyLord installer
cd /d "%~dp0"
set "REPO=%~dp0"
if "%REPO:~-1%"=="\" set "REPO=%REPO:~0,-1%"
set "PANEL_SRC=%REPO%\packages\adobe-cep"
set "EXT_ROOT=%APPDATA%\Adobe\CEP\extensions"
set "PANEL_DEST=%EXT_ROOT%\com.lazylord.panel"
set "FIGMA_MANIFEST=%REPO%\packages\figma-plugin\manifest.json"
set "BUILD_WARN="

if /i "%~1"=="/uninstall" goto :uninstall

echo ============================================================
echo   LazyLord installer
echo   Figma + Photoshop + Illustrator + After Effects
echo ============================================================
echo.

rem ---------------------------------------------------------------- 1. Node.js
echo [1/7] Checking Node.js...
where node >nul 2>nul
if errorlevel 1 goto :no_node
for /f "tokens=1 delims=." %%v in ('node -v') do set "NODEMAJOR=%%v"
set "NODEMAJOR=%NODEMAJOR:v=%"
if %NODEMAJOR% LSS 18 (
  echo [!] Node.js %NODEMAJOR% is too old. Install Node.js 18 or newer - LTS is best - and run install.bat again.
  goto :fail
)
echo       Node.js %NODEMAJOR% found.

rem ---------------------------------------------------------------- 2. packages
echo.
echo [2/7] Installing packages - npm install...
call npm install
if errorlevel 1 (
  echo [!] npm install failed. Check your internet connection and the messages above.
  goto :fail
)

rem ---------------------------------------------------------------- 3. build
echo.
echo [3/7] Building core, Figma plugin and bridge...
call :build "core" "@lazylord/core" "packages\core\dist\index.js"
if errorlevel 1 goto :fail
call :build "Figma plugin" "@lazylord/figma-plugin" "packages\figma-plugin\dist\ui.html"
if errorlevel 1 goto :fail
call :build "bridge" "@lazylord/bridge" "packages\bridge\dist\server.js"
if errorlevel 1 goto :fail

rem ---------------------------------------------------------------- 4. ExtendScript check
echo.
echo [4/7] Checking the Adobe scripts parse as ExtendScript...
cscript //Nologo "%REPO%\tools\check-extendscript.js"
if errorlevel 1 (
  echo [warn] The ExtendScript check failed. The panel may not load; please send the messages above.
  set "BUILD_WARN=1"
)

rem ---------------------------------------------------------------- 5. Adobe panel
echo.
echo [5/7] Installing the Adobe panel for Photoshop, Illustrator and After Effects...
rem Unsigned development panels only load with PlayerDebugMode on.
for %%v in (9 10 11 12 13) do reg add "HKCU\Software\Adobe\CSXS.%%v" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul
echo       CEP debug mode enabled for CSXS 9-13.
if not exist "%EXT_ROOT%" mkdir "%EXT_ROOT%"
call :remove_panel
rem A junction needs no admin rights and keeps the panel in sync with this folder.
mklink /J "%PANEL_DEST%" "%PANEL_SRC%" >nul 2>nul
if errorlevel 1 (
  echo       Could not create a link; copying the panel instead.
  echo       Re-run install.bat after pulling new code.
  xcopy "%PANEL_SRC%" "%PANEL_DEST%\" /e /i /y /q >nul
  if errorlevel 1 (
    echo [!] Could not install the panel into %PANEL_DEST%
    goto :fail
  )
) else (
  echo       Linked %PANEL_DEST%
)

rem ---------------------------------------------------------------- 6. Figma
echo.
echo [6/7] Figma plugin
echo       Figma does not allow scripts to install plugins, so do this once:
echo         1. Open the Figma DESKTOP app - the browser version cannot reach the bridge.
echo         2. Menu - Plugins - Development - Import plugin from manifest...
echo         3. Pick this file - its path is already on your clipboard, paste it:
echo            %FIGMA_MANIFEST%
echo         4. Run it from Plugins - Development - LazyLord.
echo       After later code changes, just re-run install.bat; Figma picks up the rebuilt plugin.
echo %FIGMA_MANIFEST%| clip
start "" explorer /select,"%FIGMA_MANIFEST%"

rem ---------------------------------------------------------------- 7. bridge
echo.
echo [7/7] Bridge
if exist "%PANEL_SRC%\js\relay.js" (
  echo       Built into the panel - no window to keep open. The first LazyLord
  echo       panel you open in Photoshop, Illustrator or After Effects runs it.
) else (
  echo [warn] The panel's bridge was not built; use start-bridge.bat until install.bat succeeds.
  set "BUILD_WARN=1"
)

echo.
echo ============================================================
if defined BUILD_WARN (
  echo   Installed WITH WARNINGS - scroll up and send them to the developer.
) else (
  echo   Installed.
)
echo ============================================================
echo   Next:
echo   - Restart Photoshop, Illustrator and After Effects if they are open.
echo   - In each: Window - Extensions (legacy) - LazyLord. The dot turns green
echo     once it is connected; with one panel open, Figma connects too.
echo   - There is no bridge window any more: keep one LazyLord panel open.
echo   - Follow TESTING.md for the checklist.
echo.
goto :end

rem ================================================================ helpers

:build
rem %1 label, %2 workspace, %3 file the build must produce
echo.
echo --- %~1
if exist "%REPO%\%~3" del /q "%REPO%\%~3"
call npm run build --workspace %~2
if not errorlevel 1 exit /b 0
if exist "%REPO%\%~3" (
  echo [warn] %~1: TypeScript reported errors above, but the output was produced, so testing can go ahead.
  echo        Please send those messages to the developer - types were never checked on the dev machine.
  set "BUILD_WARN=1"
  exit /b 0
)
echo [!] %~1 failed to build - see the messages above.
exit /b 1

:remove_panel
if not exist "%PANEL_DEST%" exit /b 0
rem A junction is removed with a plain rmdir, which never touches the source folder.
dir /a:l /b "%EXT_ROOT%" 2>nul | findstr /i /x "com.lazylord.panel" >nul
if not errorlevel 1 (
  rmdir "%PANEL_DEST%"
) else (
  rmdir /s /q "%PANEL_DEST%"
)
exit /b 0

:no_node
echo [!] Node.js was not found.
where winget >nul 2>nul
if errorlevel 1 (
  echo     Install Node.js LTS from https://nodejs.org and run install.bat again.
  goto :fail
)
choice /c YN /m "    Install Node.js LTS now with winget"
if errorlevel 2 (
  echo     Install Node.js LTS from https://nodejs.org and run install.bat again.
  goto :fail
)
winget install -e --id OpenJS.NodeJS.LTS
echo.
echo     If Node.js installed, CLOSE this window and run install.bat again
echo     so Windows picks up the new PATH.
goto :end

:uninstall
echo Removing the LazyLord Adobe panel...
call :remove_panel
echo Done. CEP debug mode was left on, since other panels may rely on it.
echo In Figma, remove the plugin from Plugins - Development - Manage plugins in development.
goto :end

:fail
echo.
echo Installation stopped. Fix the problem above and run install.bat again.

:end
echo.
pause
endlocal
