#!/bin/bash
# Ad-hoc signs CinergyPro.app and removes the download quarantine so macOS lets it run.
# Usage: ./scripts/sign-mac.sh [path/to/CinergyPro.app]   (default: /Applications/CinergyPro.app)
set -e
APP="${1:-/Applications/CinergyPro.app}"
if [ ! -d "$APP" ]; then echo "Not found: $APP"; exit 1; fi

xattr -cr "$APP"
codesign --force --sign - "$APP/Contents/Resources/bin/ffmpeg" "$APP/Contents/Resources/bin/ffprobe"
find "$APP/Contents/Frameworks" -depth \( -name "*.dylib" -o -name "*.framework" -o -name "*.app" -o -name "chrome_crashpad_handler" \) -exec codesign --force --sign - {} \;
codesign --force --sign - "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"
xattr -l "$APP"
echo "Signed: $APP"
