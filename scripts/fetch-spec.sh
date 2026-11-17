#!/usr/bin/env bash
# Fetch the device-side BLE specification from the pico2_aprs repository.
# The spec is the source of truth and may change, so it is never committed here.
#   REF=<branch|tag|sha> scripts/fetch-spec.sh      (default: radio-interface-schematic)
set -euo pipefail

REPO="${REPO:-klaNath/pico2_aprs}"
REF="${REF:-radio-interface-schematic}"
FILES=(ble-protocol.md ble-control.md)
OUT="$(cd "$(dirname "$0")/.." && pwd)/docs/spec"

mkdir -p "$OUT"
for f in "${FILES[@]}"; do
  gh api -H "Accept: application/vnd.github.raw" "repos/$REPO/contents/docs/$f?ref=$REF" > "$OUT/$f.tmp"
  mv "$OUT/$f.tmp" "$OUT/$f"
done

SHA="$(gh api "repos/$REPO/commits/$REF" --jq .sha)"
printf 'repo: %s\nref: %s\ncommit: %s\nfetched: %s\n' "$REPO" "$REF" "$SHA" "$(date -u +%FT%TZ)" > "$OUT/SOURCE.txt"
echo "spec fetched from $REPO@$REF (${SHA:0:7}) -> $OUT"
grep -m1 "Document version" "$OUT/ble-protocol.md" || true
