@echo off
rem LazyLord - puts the Figma half where Figma can keep reading it, and hands
rem you the one path you have to paste.
rem
rem Figma cannot be told to install a plugin by any program, so the last three
rem clicks are yours. This makes them as short as they can be.

setlocal EnableExtensions
title Add the LazyLord plugin to Figma
cd /d "%~dp0"

set "SRC=%~dp0Figma plugin"
set "HOME_DIR=%LOCALAPPDATA%\LazyLord\Figma plugin"

echo ============================================================
echo   LazyLord - the Figma half
echo ============================================================
echo.

if not exist "%SRC%\manifest.json" (
  echo [!] The "Figma plugin" folder is not next to this file.
  echo     Unzip the whole download first, then run this from inside that folder.
  goto :fail
)

rem Figma reads these files every time the plugin runs, so they cannot live in a
rem download folder that gets tidied away later.
echo Copying the plugin somewhere it can stay...
if exist "%HOME_DIR%" rmdir /s /q "%HOME_DIR%"
xcopy "%SRC%" "%HOME_DIR%\" /e /i /y /q >nul
if not exist "%HOME_DIR%\manifest.json" (
  echo [!] Could not copy it to %HOME_DIR%
  goto :fail
)
echo       %HOME_DIR%
echo.

rem The path goes on the clipboard: Figma's file dialog takes a pasted path,
rem which is far less work than clicking through folders.
echo %HOME_DIR%\manifest.json| clip

echo Now, in Figma:
echo.
echo   1. Open the Figma DESKTOP app  ^(the browser cannot reach your computer^).
echo   2. Menu - Plugins - Development - Import plugin from manifest...
echo   3. A file window opens. The path is already copied, so just press
echo      Ctrl+V and then Enter.
echo.
echo   Run it any time from  Plugins - Development - LazyLord.
echo.
echo If Ctrl+V does not paste, the path is:
echo   %HOME_DIR%\manifest.json
echo.
echo You can delete this download folder afterwards - the plugin has its own copy.
goto :end

:fail
echo.
echo Nothing was added. Fix the problem above and run this again.

:end
echo.
pause
