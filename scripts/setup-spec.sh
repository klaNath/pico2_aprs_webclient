#!/usr/bin/env bash
# Set up (or update) the device-side BLE spec, tracked as a git submodule.
#
# The spec lives in klaNath/pico2_aprs and is the source of truth. It is a submodule
# (docs/spec-src) pinned to a commit, with sparse-checkout limited to the two BLE docs.
# Sparse-checkout settings are per clone, so this script must be run after every fresh clone.
#
#   scripts/setup-spec.sh            init the submodule at the pinned commit + apply sparse-checkout
#   scripts/setup-spec.sh --update   move the pin to the latest commit of the tracked branch
#                                    (then review the diff and commit the new pin)
#
# Spec files: docs/spec-src/docs/ble-protocol.md, docs/spec-src/docs/ble-control.md
set -euo pipefail
cd "$(dirname "$0")/.."

SUB=docs/spec-src
FILES=(/docs/ble-protocol.md /docs/ble-control.md)

git submodule update --init --depth 1 -- "$SUB"
if [ "${1:-}" = "--update" ]; then
  OLD="$(git -C "$SUB" rev-parse HEAD)"
  git submodule update --remote --depth 1 -- "$SUB"
  NEW="$(git -C "$SUB" rev-parse HEAD)"
  [ "$OLD" = "$NEW" ] && echo "spec already up to date (${NEW:0:7})" || echo "spec pin moved: ${OLD:0:7} -> ${NEW:0:7}"
fi
git -C "$SUB" sparse-checkout set --no-cone "${FILES[@]}"

echo "spec at $(git -C "$SUB" rev-parse --short HEAD) ($(git config -f .gitmodules submodule.$SUB.branch))"
ls "$SUB/docs"
grep -m1 "Document version" "$SUB/docs/ble-protocol.md" || true
