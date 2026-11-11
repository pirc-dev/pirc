#!/bin/bash
# The mobile app's icons, from the web app's master (web/page/logo.png,
# docs/web.md): iOS's app icon set; Android's launcher icons, an adaptive
# icon (the mark on the logo's own background), and the notification icon,
# the mark in white on nothing, as Android draws it. Needs ImageMagick
# (magick); run it again after the logo changes, and look at what it made.
set -euo pipefail
cd "$(dirname "$0")/.."

logo=web/page/logo.png
bg='#0E0D12'
res=app/android/app/src/main/res
ios=app/ios/Runner/Assets.xcassets/AppIcon.appiconset
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# The mark alone: everything that is not the background, on transparency.
magick "$logo" -fuzz 6% -transparent "$bg" -trim +repage "$tmp/mark.png"

# iOS: every size the set names, with no alpha, as the App Store wants.
for f in "$ios"/Icon-App-*.png; do
  name=$(basename "$f" .png)
  size=${name#Icon-App-}
  points=${size%%x*}
  scale=${size##*@}
  px=$(python3 -c "print(round($points * ${scale%x}))")
  magick "$logo" -resize "${px}x${px}" -background "$bg" -alpha remove -alpha off "$f"
done

# Android: the legacy launcher icon, whole.
for d in mdpi:48 hdpi:72 xhdpi:96 xxhdpi:144 xxxhdpi:192; do
  magick "$logo" -resize "${d#*:}x${d#*:}" "$res/mipmap-${d%%:*}/ic_launcher.png"
done

# Android 8 and later: the adaptive icon's foreground, the mark within the
# middle two thirds of its 108 dp, over the background colour.
for d in mdpi:108 hdpi:162 xhdpi:216 xxhdpi:324 xxxhdpi:432; do
  px=${d#*:}
  inner=$((px * 52 / 100))
  magick "$tmp/mark.png" -resize "${inner}x${inner}" -background none -gravity center -extent "${px}x${px}" "$res/mipmap-${d%%:*}/ic_launcher_foreground.png"
  # Themed icons (Android 13): the same, in one colour the system picks.
  magick "$tmp/mark.png" -alpha extract -background white -alpha shape -resize "${inner}x${inner}" -background none -gravity center -extent "${px}x${px}" "$res/mipmap-${d%%:*}/ic_launcher_monochrome.png"
done
mkdir -p "$res/mipmap-anydpi-v26"
cat > "$res/mipmap-anydpi-v26/ic_launcher.xml" <<'EOF'
<?xml version="1.0" encoding="utf-8"?>
<!-- Made by sh/app-icons.sh. -->
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
    <monochrome android:drawable="@mipmap/ic_launcher_monochrome" />
</adaptive-icon>
EOF
cat > "$res/values/ic_launcher_background.xml" <<EOF
<?xml version="1.0" encoding="utf-8"?>
<!-- Made by sh/app-icons.sh: the logo's background. -->
<resources>
    <color name="ic_launcher_background">$bg</color>
</resources>
EOF

# The notification icon: the mark in white, within 20 of its 24 dp.
for d in mdpi:24 hdpi:36 xhdpi:48 xxhdpi:72 xxxhdpi:96; do
  px=${d#*:}
  inner=$((px * 20 / 24))
  mkdir -p "$res/drawable-${d%%:*}"
  magick "$tmp/mark.png" -alpha extract -background white -alpha shape -resize "${inner}x${inner}" -background none -gravity center -extent "${px}x${px}" "$res/drawable-${d%%:*}/ic_notification.png"
done
echo "icons written; look at them before keeping them"
