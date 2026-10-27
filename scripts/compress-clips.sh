#!/usr/bin/env bash
# (The app now shrinks clips by itself while they upload. This script is only for clips that are already on a computer.)
# Shrink training clips without a visible loss of quality (H.265, CRF 23, same resolution up to 1080p).
# Originals are never touched: smaller copies go into a "compressed" folder next to them.
#
# Usage:   scripts/compress-clips.sh <folder or files...>
# Needs:   ffmpeg (Mac: brew install ffmpeg)
# Example: scripts/compress-clips.sh ~/Downloads/clips
#
# Notes
#  - Clips already at a low bitrate (under 6 Mbps) are skipped, because squeezing them further would cost quality.
#  - 4K clips are scaled down to 1080p, which is plenty for analysis and social media.
#  - CRF 23 with H.265 is visually the same as the original at normal viewing size. Use CRF=20 for a bigger, safer file.
set -euo pipefail

CRF="${CRF:-23}"
MIN_KBPS="${MIN_KBPS:-6000}"

command -v ffmpeg >/dev/null || { echo "ffmpeg is not installed (Mac: brew install ffmpeg)"; exit 1; }
[ "$#" -ge 1 ] || { echo "Usage: $0 <folder or files...>"; exit 1; }

files=()
for arg in "$@"; do
  if [ -d "$arg" ]; then
    while IFS= read -r f; do files+=("$f"); done < <(find "$arg" -maxdepth 1 -type f \( -iname '*.mp4' -o -iname '*.mov' -o -iname '*.m4v' \) ! -path '*/compressed/*' | sort)
  elif [ -f "$arg" ]; then files+=("$arg"); fi
done
[ "${#files[@]}" -gt 0 ] || { echo "No video files found."; exit 1; }

saved_total=0
for f in "${files[@]}"; do
  dir="$(dirname "$f")"; base="$(basename "$f")"; name="${base%.*}"
  out="$dir/compressed/$name.mp4"
  mkdir -p "$dir/compressed"
  [ -e "$out" ] && { echo "skip (already done): $base"; continue; }

  kbps=$(ffprobe -v error -select_streams v:0 -show_entries stream=bit_rate -of csv=p=0 "$f" 2>/dev/null | head -1)
  [[ "$kbps" =~ ^[0-9]+$ ]] || kbps=$(ffprobe -v error -show_entries format=bit_rate -of csv=p=0 "$f" | head -1)
  kbps=$(( ${kbps:-0} / 1000 ))
  if [ "$kbps" -gt 0 ] && [ "$kbps" -lt "$MIN_KBPS" ]; then echo "skip (already small, ${kbps} kbps): $base"; continue; fi

  echo "compressing: $base"
  ffmpeg -nostdin -loglevel error -stats -i "$f" \
    -vf "scale='min(1920,iw)':-2:flags=lanczos" \
    -c:v libx265 -crf "$CRF" -preset medium -pix_fmt yuv420p -tag:v hvc1 \
    -c:a aac -b:a 128k -movflags +faststart -map_metadata 0 "$out"

  before=$(wc -c < "$f"); after=$(wc -c < "$out")
  saved_total=$(( saved_total + before - after ))
  printf "  %s MB -> %s MB (%s%% smaller)\n" "$(( before / 1048576 ))" "$(( after / 1048576 ))" "$(( 100 - after * 100 / before ))"
done
echo "Done. Saved about $(( saved_total / 1048576 )) MB. Check the clips in the compressed folder, then delete the originals if you are happy."
