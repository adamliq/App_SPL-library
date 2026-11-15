#!/usr/bin/env bash
# Check the app source and package it as dist/spl-library_<version>.spl.
# Usage: scripts/build.sh [output-dir]
set -euo pipefail

cd "$(dirname "$0")/.."
APP=spl_library
OUT_DIR=${1:-dist}

fail() { echo "error: $*" >&2; exit 1; }

versions=$(sed -n 's/^version[[:space:]]*=[[:space:]]*//p' "$APP/default/app.conf" | tr -d '[:blank:]\r' | sort -u)
[[ $(wc -l <<<"$versions") -eq 1 ]] || fail "app.conf [id] and [launcher] versions differ: $(echo $versions)"
version=$versions
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "app.conf version '$version' is not X.Y.Z"

# AppInspect rejects hidden files such as .DS_Store
hidden=$(find "$APP" -name '.*' -print)
[[ -z $hidden ]] || fail "hidden files in $APP: $hidden"

if command -v node >/dev/null; then
  for js in $(find "$APP" -name '*.js' | sort); do node --check "$js" || fail "syntax error in $js"; done
else
  echo "warning: node not found, skipping JavaScript syntax check" >&2
fi

find "$APP" -name '*.xml' -print0 | sort -z |
  xargs -0 -r python3 -c 'import sys, xml.dom.minidom as m; [m.parse(f) for f in sys.argv[1:]]' ||
  fail "malformed XML in $APP"

# Fixed timestamps, owners and entry order make the package byte-for-byte reproducible
epoch=${SOURCE_DATE_EPOCH:-$(git log -1 --format=%ct 2>/dev/null || date +%s)}
mkdir -p "$OUT_DIR"
out="$OUT_DIR/spl-library_${version//./}.spl"
tar --sort=name --mtime="@$epoch" --owner=0 --group=0 --numeric-owner \
    --mode='u=rwX,go=rX' -cf - "$APP" | gzip -n -9 > "$out"

echo "built $out (version $version)"
