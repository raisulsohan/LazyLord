@echo off
rem Only needed if LazyLord opens as a blank panel.
rem
rem Adobe verifies a panel's signature as the app loads it, and on some machines
rem that check fails even for a correctly signed panel - Adobe has a note about
rem it dated November 2024. The switch below tells Adobe's extension layer to
rem load the panel anyway. It is Adobe's own setting, it lives under the current
rem user only, and other panels you have installed may already rely on it.

setlocal EnableExtensions
title LazyLord - fix a blank panel

echo This turns on Adobe's "PlayerDebugMode" for your user account, which lets
echo Adobe apps load a panel whose signature check did not complete.
echo.
choice /c YN /m "Turn it on now"
if errorlevel 2 goto :end

for %%v in (9 10 11 12 13 14) do reg add "HKCU\Software\Adobe\CSXS.%%v" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul
echo.
echo Done. Restart Photoshop, Illustrator or After Effects and open the panel again.
echo If it is still blank, please tell the developer which app and version it was.

:end
echo.
pause
