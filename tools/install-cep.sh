#!/usr/bin/env bash
# LazyLord — install the CEP panel for development (macOS).
# Enables CEP unsigned-extension debug mode and links the panel into the
# per-user CEP extensions folder.
#
#   ./tools/install-cep.sh            install
#   ./tools/install-cep.sh --uninstall
set -euo pipefail

BUNDLE_ID="com.lazylord.panel"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE="$REPO_ROOT/packages/adobe-cep"
EXT_ROOT="$HOME/Library/Application Support/Adobe/CEP/extensions"
DEST="$EXT_ROOT/$BUNDLE_ID"

if [[ "${1:-}" == "--uninstall" ]]; then
  rm -rf "$DEST" && echo "Removed $DEST" || echo "Nothing to remove"
  exit 0
fi

# 1) Enable unsigned extensions for CC 2021+ (CSXS 9-12).
for v in 9 10 11 12; do
  defaults write "com.adobe.CSXS.$v" PlayerDebugMode 1
  echo "PlayerDebugMode=1 for CSXS.$v"
done

# 2) Link the panel.
mkdir -p "$EXT_ROOT"
rm -rf "$DEST"
ln -s "$SOURCE" "$DEST"
echo "Symlinked $DEST -> $SOURCE"

echo
echo "Done. Restart Photoshop / Illustrator / After Effects, then open"
echo "  Window > Extensions (legacy) > LazyLord"
