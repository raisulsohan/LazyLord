#!/bin/bash
# LazyLord - puts the Figma half where Figma can keep reading it, and hands you
# the one path you have to paste. Double-click this file; if macOS refuses,
# right-click it and choose Open.
set -u

cd "$(dirname "$0")"
SRC="$(pwd)/Figma plugin"
HOME_DIR="$HOME/Library/Application Support/LazyLord/Figma plugin"

echo "============================================================"
echo "  LazyLord - the Figma half"
echo "============================================================"
echo

if [ ! -f "${SRC}/manifest.json" ]; then
  echo "[!] The 'Figma plugin' folder is not next to this file."
  echo "    Unzip the whole download first, then run this from inside that folder."
  read -r -p "Press return to close. " _
  exit 1
fi

# Figma reads these files every time the plugin runs, so they cannot live in a
# download folder that gets tidied away later.
echo "Copying the plugin somewhere it can stay..."
rm -rf "${HOME_DIR}"
mkdir -p "$(dirname "${HOME_DIR}")"
cp -R "${SRC}" "${HOME_DIR}"
if [ ! -f "${HOME_DIR}/manifest.json" ]; then
  echo "[!] Could not copy it to ${HOME_DIR}"
  read -r -p "Press return to close. " _
  exit 1
fi
echo "      ${HOME_DIR}"
echo

# The path goes on the clipboard: Figma's file dialog takes a pasted path,
# which is far less work than clicking through folders.
printf '%s' "${HOME_DIR}/manifest.json" | pbcopy 2>/dev/null || true

echo "Now, in Figma:"
echo
echo "  1. Open the Figma DESKTOP app (Figma only imports plugins there)."
echo "  2. Menu > Plugins > Development > Import plugin from manifest…"
echo "  3. A file window opens. Press Cmd+Shift+G, then Cmd+V to paste the path,"
echo "     then Return — the path is already copied."
echo
echo "  Run it any time from  Plugins > Development > LazyLord."
echo
echo "If pasting does not work, the path is:"
echo "  ${HOME_DIR}/manifest.json"
echo
echo "You can delete this download folder afterwards - the plugin has its own copy."
read -r -p "Press return to close. " _
