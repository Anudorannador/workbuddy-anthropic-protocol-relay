#!/usr/bin/env bash
# Build a macOS background-only .app bundle that starts the relay.
# Output: dist/RelayLauncher.app
#
# Needed on machines where `launchctl bootstrap` fails, because a Login Item
# is the only supported way to start something at login.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$DIR/dist"
APP="$OUT/RelayLauncher.app"

command -v osacompile >/dev/null 2>&1 || { echo "error: osacompile not found (macOS only)" >&2; exit 1; }

rm -rf "$APP"
mkdir -p "$OUT"

# The bundle runs start.sh at the repository's current absolute path.
osacompile -o "$APP" -e "do shell script \"cd '$DIR' && nohup ./scripts/start.sh >> relay.log 2>&1 &\""

PLIST="$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Add :CFBundleIdentifier string local.protocol.relay" "$PLIST" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier local.protocol.relay" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string Protocol Relay" "$PLIST" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName Protocol Relay" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :LSUIElement bool true" "$PLIST" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Set :LSUIElement true" "$PLIST"

codesign -f -s - "$APP"
codesign --verify --strict "$APP"

echo "built: $APP"
echo "next:  open \"$APP\""
echo "then add it to System Settings -> General -> Login Items"
