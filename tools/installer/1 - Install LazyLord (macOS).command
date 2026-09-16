#!/bin/bash
# LazyLord - installs the panel for Photoshop, Illustrator and After Effects.
# Double-click this file. If macOS refuses, right-click it and choose Open.
set -u

cd "$(dirname "$0")"
DEST="$HOME/Library/Application Support/Adobe/CEP/extensions/com.lazylord.panel"

echo "============================================================"
echo "  LazyLord - install"
echo "  Photoshop  .  Illustrator  .  After Effects  .  Figma"
echo "============================================================"
echo
echo "Close Photoshop, Illustrator and After Effects before going on."
read -r -p "Press return when they are closed. " _
echo

zxp=$(ls -1 ./*.zxp 2>/dev/null | head -1 || true)
if [ -z "${zxp}" ]; then
  echo "[!] There is no LazyLord .zxp file next to this one."
  echo "    Unzip the whole download first, then run this from inside that folder."
  read -r -p "Press return to close. " _
  exit 1
fi

echo "Installing ${zxp}"
echo "        to ${DEST}"
rm -rf "${DEST}"
mkdir -p "${DEST}"
if ! unzip -q -o "${zxp}" -d "${DEST}"; then
  echo "[!] Could not unpack the panel."
  read -r -p "Press return to close. " _
  exit 1
fi
# Quarantine flags on a downloaded file travel into what it unpacks.
xattr -dr com.apple.quarantine "${DEST}" 2>/dev/null || true

if [ ! -f "${DEST}/CSXS/manifest.xml" ]; then
  echo "[!] The panel did not unpack correctly."
  read -r -p "Press return to close. " _
  exit 1
fi

echo
echo "============================================================"
echo "  Installed."
echo "============================================================"
echo
echo "  Open it in each app:"
echo "    Photoshop      Window > Extensions (legacy) > LazyLord"
echo "    Illustrator    Window > Extensions > LazyLord"
echo "    After Effects  Window > Extensions > LazyLord"
echo
echo "  The dot turns green when the panel is ready. Keep one LazyLord"
echo "  panel open and Figma can reach it - there is no separate bridge."
echo
echo "  Figma: run '2 - Add the Figma plugin (macOS).command' next. Skip it if"
echo "  you only move things between the Adobe apps."
echo
echo "  If a panel opens blank, run this in Terminal and restart the app:"
echo "    defaults write com.adobe.CSXS.11 PlayerDebugMode 1"
echo
read -r -p "Press return to close. " _
