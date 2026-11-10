#!/usr/bin/env bash
# Honest-claims lint (the honest-claims rule). Usage: claims-lint.sh [files...]
set -euo pipefail
cd "$(dirname "$0")/../.."

if [ "$#" -gt 0 ]; then
  files=("$@")
else
  files=(README.md JUDGES.md)
  for f in video/script.md submission/x-post.txt submission/idea.txt; do
    [ -f "$f" ] && files+=("$f")
  done
fi

violations=0
fail() { echo "FAIL $1:$2: $3"; violations=$((violations + 1)); }

# pattern<TAB>exception regex (a matching line is skipped when the exception also matches)
forbidden=(
  'succeeds?|succeeded@@'
  'sealed forever@@'
  'JAMBO launch|sealed launch@@'
  'bidders never come back@@'
  'claud[e]|anthropi[c]@@'
  'no tee@@add no TEE and no committee of our own'
  '10 of 15|10-of-15|10/15|ten of fifteen@@'
  'first to|the first|world.?s first|first ever@@'
  '2,319 auctions@@'
  'external bids@@'
  'fail privately@@'
  'BRETT@@'
  'NOVELTY\.md@@'
  'agents can bid@@'
  'built solo@@'
  'trustless@@'
  'guaranteed?@@not a mathematical guarantee'
  '3\.17\.0@@byte-identical to 3\.17\.0'
  'unique|novel|revolutionary|seamless@@'
)

for f in "${files[@]}"; do
  [ -f "$f" ] || { echo "FAIL $f:0: file not found"; violations=$((violations + 1)); continue; }
  for entry in "${forbidden[@]}"; do
    pat="${entry%%@@*}"
    exc="${entry##*@@}"
    while IFS= read -r hit; do
      [ -z "$hit" ] && continue
      ln="${hit%%:*}"
      text="${hit#*:}"
      if [ -n "$exc" ] && printf '%s\n' "$text" | grep -qiE "$exc"; then continue; fi
      fail "$f" "$ln" "$pat"
    done < <(grep -inE "\\b($pat)\\b" "$f" || true)
  done
done

# Required phrases (README only)
for f in "${files[@]}"; do
  [ "$(basename "$f")" = "README.md" ] || continue
  [ -f "$f" ] || continue
  req=('^Problem:' 'never requested' '11 of 16' 'We add no TEE and no committee of our own'
       'min_escrow' 'min_bidders' 'receipt-freeness' 'bond' 'key_requests = 0'
       'domain-2 master key' 'Team-funded demo sales' 'configured by us to fail its thresholds'
       'No AI in the product, on purpose' 'Arrow' '^1\. ' ' - see ')
  for r in "${req[@]}"; do
    if ! grep -qiE -- "$r" "$f"; then fail "$f" 0 "missing required: $r"; fi
  done
done
echo "claims-lint: $violations violations"
[ "$violations" -eq 0 ]
