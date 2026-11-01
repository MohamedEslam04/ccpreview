#!/usr/bin/env bash
# Rebuild the README teaser GIF from the full demo video.
# Usage: scripts/make-teaser.sh [start_seconds] [duration_seconds]
# Defaults: 15s in, 14s long. Tries smaller settings until the GIF is under 5MB.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VIDEO="$ROOT/docs/media/ccpreview-demo.mp4"
OUT="$ROOT/docs/media/demo-teaser.gif"
START="${1:-15}"
DURATION="${2:-14}"
LIMIT=5242880
PAL="$(mktemp --suffix=.png)"
trap 'rm -f "$PAL"' EXIT

command -v ffmpeg >/dev/null || { echo "ffmpeg is required" >&2; exit 1; }

for cfg in "900 12 128" "800 10 96" "720 10 64"; do
  read -r W FPS COLORS <<<"$cfg"
  ffmpeg -v error -y -ss "$START" -t "$DURATION" -i "$VIDEO" \
    -vf "fps=$FPS,scale=$W:-1:flags=lanczos,palettegen=max_colors=$COLORS:stats_mode=diff" "$PAL"
  ffmpeg -v error -y -ss "$START" -t "$DURATION" -i "$VIDEO" -i "$PAL" \
    -lavfi "fps=$FPS,scale=$W:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" "$OUT"
  SIZE=$(stat -c %s "$OUT")
  echo "width=$W fps=$FPS colors=$COLORS -> $SIZE bytes"
  if [ "$SIZE" -lt "$LIMIT" ]; then exit 0; fi
done
echo "warning: GIF is still over 5MB, shorten the duration" >&2
