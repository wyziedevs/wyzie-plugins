#!/usr/bin/env bash
#
# Builds a hostable Kodi repository for the Wyzie add-ons.
#
# Output (under ./dist), ready to upload to any static host (GitHub Pages, R2,
# S3, nginx) at the URL you put in repository.wyzie/addon.xml:
#
#   dist/
#   ├── addons.xml
#   ├── addons.xml.md5
#   └── zips/
#       ├── repository.wyzie/repository.wyzie-<ver>.zip
#       └── service.subtitles.wyzie/service.subtitles.wyzie-<ver>.zip
#
# Users then install repository.wyzie-<ver>.zip once; Kodi handles updates after.
#
# Requirements: bash, zip, and one of md5sum / md5. Run from this directory:
#   cd kodi-repo && ./build.sh
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
addon_src="$here/../kodi"                 # the service.subtitles.wyzie add-on
repo_src="$here/repository.wyzie"         # the repository add-on
dist="$here/dist"
zips="$dist/zips"

# Pull the version out of an addon.xml's <addon ...> root tag. (Grepping the
# first version="..." would wrongly match the XML declaration's version="1.0".)
get_version() { awk '/<addon /{f=1} f{print} f&&/>/{exit}' "$1" | grep -m1 -oE 'version="[^"]+"' | sed -E 's/version="([^"]+)"/\1/'; }

md5_of() {
  if command -v md5sum >/dev/null 2>&1; then md5sum "$1" | cut -d' ' -f1;
  elif command -v md5 >/dev/null 2>&1; then md5 -q "$1";
  else echo "ERROR: need md5sum or md5" >&2; exit 1; fi
}

# package <src-dir> <addon-id> <version>
package() {
  local src="$1" id="$2" ver="$3"
  local out="$zips/$id"
  mkdir -p "$out"
  # Zip with the add-on id as the top-level folder (Kodi requires this layout).
  local tmp="$here/.pkg"
  rm -rf "$tmp"; mkdir -p "$tmp/$id"
  cp -R "$src"/. "$tmp/$id/"
  # Don't ship caches.
  find "$tmp/$id" -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null || true
  (cd "$tmp" && zip -rq "$out/$id-$ver.zip" "$id")
  rm -rf "$tmp"
  echo "  packaged $id-$ver.zip"
}

echo "Cleaning $dist"
rm -rf "$dist"; mkdir -p "$zips"

addon_ver="$(get_version "$addon_src/addon.xml")"
repo_ver="$(get_version "$repo_src/addon.xml")"
echo "service.subtitles.wyzie v$addon_ver · repository.wyzie v$repo_ver"

package "$addon_src" "service.subtitles.wyzie" "$addon_ver"
package "$repo_src"  "repository.wyzie"        "$repo_ver"

# addons.xml = XML header + every add-on's <addon>…</addon> block + footer.
echo "Generating addons.xml"
{
  echo '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  echo '<addons>'
  # Strip each addon.xml's own XML declaration, keep the <addon> element.
  grep -v '<?xml' "$addon_src/addon.xml"
  grep -v '<?xml' "$repo_src/addon.xml"
  echo '</addons>'
} > "$dist/addons.xml"

md5_of "$dist/addons.xml" > "$dist/addons.xml.md5"

# Stable, version-independent copy of the repository installer so the link we
# put on the website / docs survives version bumps.
cp "$zips/repository.wyzie/repository.wyzie-$repo_ver.zip" "$dist/repository.wyzie.zip"

echo "Done. Upload the contents of $dist to your repo host."
echo "Then distribute the stable link: <host>/repository.wyzie.zip"
echo "(versioned copy also at: zips/repository.wyzie/repository.wyzie-$repo_ver.zip)"
