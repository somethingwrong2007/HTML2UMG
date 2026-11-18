#!/usr/bin/env bash
# Engine-tier test loop for the Slate output.
#
# For every fixture: convert -> emit a pack -> copy the generated sources into the plugin -> one build
# -> render each widget by name + dump the geometry Slate computed -> compare that geometry with the
# layout rects and diff the png against the browser screenshot.
#
# This is the loop to re-run after changing the emitter. The plugin build is the slow part, so all
# fixtures are built together.
#
#   bash test/slate/engine_tests.sh [fixture ...]
#
# Requires: this checkout of the plugin builds (h2u-build.bat) and the preview harness
# (.dsh-scratch/slate-preview/Html2UMGSlatePreview.cpp) exists locally - it is deliberately not part of
# the repo because it includes generated code.

set -u

CONV="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ROOT="$(cd "$CONV/../../../.." && pwd)"
OUT="$ROOT/.dsh-scratch/slate-engine-tests"
PRIVATE="$ROOT/Plugins/Html2UMG/Source/Html2UMG/Private"
HARNESS="$ROOT/.dsh-scratch/slate-preview/Html2UMGSlatePreview.cpp"
UE="${UE_EDITOR:-E:/Epic Games/UE_5.8/Engine/Binaries/Win64/UnrealEditor-Cmd.exe}"
PROJ="$ROOT/FPVSkyline.uproject"

FIXTURES=("$@")
if [ ${#FIXTURES[@]} -eq 0 ]; then
  FIXTURES=(23-slate-canvas 24-slate-controls 25-slate-switcher)
fi

mkdir -p "$OUT" "$PRIVATE"
[ -f "$HARNESS" ] || { echo "missing $HARNESS (the preview harness)"; exit 1; }

echo "[1/5] converting ${#FIXTURES[@]} fixture(s)"
JSONS=()
for name in "${FIXTURES[@]}"; do
  MSYS_NO_PATHCONV=1 node "$CONV/cli/convert.js" "$CONV/test/$name.html" \
    -o "$OUT/$name.json" --assets "$OUT/a_$name" --viewport 0x0 --font-policy=engine --font-map=ignore >/dev/null 2>&1 || true
  JSONS+=("$OUT/$name.json")
done

echo "[2/5] emitting the Slate pack"
node "$CONV/cli/html2slate-pack.js" "${JSONS[@]}" -o "$OUT/pack" | tail -1

echo "[3/5] building the plugin (this is the slow step)"
cp "$HARNESS" "$PRIVATE/"
cp "$OUT/pack"/*.h "$OUT/pack"/*.cpp "$PRIVATE/"
( cd "$ROOT" && cmd //c ".dsh-scratch\\h2u-build.bat" >/dev/null 2>&1 )
grep -a "^Result:" "$ROOT/.dsh-scratch/h2u-build.log" | tail -1

echo "[4/5] rendering + geometry"
for name in "${FIXTURES[@]}"; do
  cls="FH2U$(echo "$name" | tr -c 'A-Za-z0-9' '_')"
  cls="FH2U${cls:4}"
  "$UE" "$PROJ" "-ExecCmds=Html2UMG.RenderSlateGenerated $cls $OUT/$name.png 1920x1080, QUIT_EDITOR" \
    -unattended -windowed -stdout > "$OUT/$name.log" 2>&1
done

echo "[5/5] comparing"
for name in "${FIXTURES[@]}"; do
  echo "--- $name"
  node "$CONV/test/slate/compare_geometry.js" "$OUT/$name.json" "$OUT/$name.png.geom.json" 2>&1 | tail -12
done

echo ""
echo "artifacts: $OUT"
