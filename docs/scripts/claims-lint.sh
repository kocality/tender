#!/usr/bin/env bash
# Honest-claims lint (the honest-claims rule). Usage: [FREEZE=1] claims-lint.sh [files...]
# FREEZE=1 additionally fails on unfinished markers (TODO(, <PLACEHOLDER>, DRAFT status lines) and on
# attack-room rows without a transaction hash; run it on the submission tag.
set -euo pipefail
cd "$(dirname "$0")/../.."

if [ "$#" -gt 0 ]; then
  files=("$@")
else
  files=(README.md JUDGES.md)
  for f in video/script.md video/captions.srt video/captions-x.srt app/src/copy.ts submission/x-post.txt submission/idea.txt; do
    [ -f "$f" ] && files+=("$f")
  done
fi

violations=0
fail() { echo "FAIL $1:$2: $3"; violations=$((violations + 1)); }

# SRT cues wrap mid-sentence, so lint one sentence per line (the cue numbers and timestamps are dropped).
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT
prep() {
  case "$1" in
    *.srt)
      out="$tmpdir/$(basename "$1").txt"
      perl -0777 -pe 's/\r//g; s/^\d+\n\d\d:\d\d:\d\d,\d+ --> [^\n]*\n//mg; s/\s*\n\s*/ /g; s/([.!?]) +/$1\n/g; $_ .= "\n"' "$1" > "$out"
      echo "$out" ;;
    *) echo "$1" ;;
  esac
}

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
  # Resharing does not revoke old shares: the collusion condition must name former share holders too.
  '(11 of (the )?16|eleven of sixteen)[^.]*collud[a-z]*|collud[a-z]*[^.]*(11 of (the )?16|eleven of sixteen)@@ever held'
  # Not every sale hides its bids (Dark Vault, Shutter do).
  'every bid is public|token sales today are public@@most'
  # The key is derived from a fixed MPC key; it is merely not requested yet.
  'doesn.t exist yet|does not exist yet@@'
  # verify --sale and verify --keys are two commands; an unrevealed bid is penalised only after the key is out.
  'one free command|bid that never opens@@'
  # The contract makes a plain promise with a callback; yield/resume happens inside v1.signer.
  'called by the contract through yield@@'
  # The seller account id is not the same as every account the team controls.
  '(0|never|never goes) to the seller@@seller.s account'
  # Sale 2 closes inside the judging window.
  'stays open during judging@@'
  # Documented command output that does not appear.
  'in about 5 s@@'
  'see .4/4. official@@'
  'finish with only the CLI@@TypeScript runner'
  # The testnet copy runs an earlier, non-reproducible build, so check #3 differs from the current wasm.
  '21/22 checks passed@@earlier'
  # Double bids: a confirmed second bid is allowed, the relayer only saves gas, another device can pay 1Click again,
  # and a pending payout is never resent.
  '(double|duplicate|repeated|second) bids? (is|are) impossible|impossible to bid twice@@'
  'relayer prevents (duplicates|double)@@'
  'never pay 1Click twice@@'
  'payouts? (is|are|gets?) retried@@'
)

for f in "${files[@]}"; do
  [ -f "$f" ] || { echo "FAIL $f:0: file not found"; violations=$((violations + 1)); continue; }
  g="$(prep "$f")"
  for entry in "${forbidden[@]}"; do
    pat="${entry%%@@*}"
    exc="${entry##*@@}"
    while IFS= read -r hit; do
      [ -z "$hit" ] && continue
      ln="${hit%%:*}"
      text="${hit#*:}"
      if [ -n "$exc" ] && printf '%s\n' "$text" | grep -qiE "$exc"; then continue; fi
      fail "$f" "$ln" "$pat"
    done < <(grep -inE "\\b($pat)\\b" "$g" || true)
  done
done

# Required phrases (README only)
for f in "${files[@]}"; do
  [ "$(basename "$f")" = "README.md" ] || continue
  [ -f "$f" ] || continue
  req=('^Problem:' 'never requested' '11 of 16' 'We add no TEE and no committee of our own'
       'min_escrow' 'min_bidders' 'receipt-freeness' 'bond' 'key_requests = 0'
       'domain-2 master key' 'Team-funded demo sales' 'configured by us to fail its thresholds'
       'No AI in the product, on purpose' 'Arrow' '^1\. ' ' - see '
       'ever held' 'Node 18')
  for r in "${req[@]}"; do
    if ! grep -qiE -- "$r" "$f"; then fail "$f" 0 "missing required: $r"; fi
  done
done

# A build hash on a reproducible-build / wasm / sha256 line must be the one in contract/res/tender.wasm.sha256.
wasm_sha=""
[ -f contract/res/tender.wasm.sha256 ] && wasm_sha="$(awk '{print $1; exit}' contract/res/tender.wasm.sha256)"
for f in "${files[@]}"; do
  case "$(basename "$f")" in README.md|JUDGES.md) ;; *) continue ;; esac
  [ -f "$f" ] || continue
  while IFS= read -r hit; do
    [ -z "$hit" ] && continue
    ln="${hit%%:*}"
    for h in $(printf '%s\n' "${hit#*:}" | grep -oE '[0-9a-f]{64}' || true); do
      [ "$h" = "$wasm_sha" ] || fail "$f" "$ln" "build hash $h is not contract/res/tender.wasm.sha256"
    done
  done < <(grep -inE 'repro|wasm|sha256|code_hash' "$f" | grep -E '[0-9a-f]{64}' || true)
done

# Freeze mode: nothing unfinished may ship.
if [ "${FREEZE:-0}" = "1" ]; then
  for f in "${files[@]}"; do
    [ -f "$f" ] || continue
    while IFS= read -r hit; do
      [ -z "$hit" ] && continue
      fail "$f" "${hit%%:*}" "freeze: unfinished marker: $(printf '%s' "${hit#*:}" | grep -oE 'TODO\([^)]{0,60}|<[A-Z][A-Z0-9_-]*>|<(hash|mode|date|docker[^>]*|YYYY-MM-DD)>|^Status[^:]*: *[Dd]raft|DRAFT' | head -1)"
    done < <(grep -nE 'TODO\(|<[A-Z][A-Z0-9_-]*>|<(hash|mode|date|docker[^>]*|YYYY-MM-DD)>|^Status[^:]*: *[Dd]raft|\bDRAFT\b' "$f" || true)
  done
  for f in "${files[@]}"; do
    [ "$(basename "$f")" = "README.md" ] || continue
    [ -f "$f" ] || continue
    while IFS= read -r hit; do
      [ -z "$hit" ] && continue
      fail "$f" "${hit%%:*}" "freeze: attack-room row without a transaction hash"
    done < <(awk '
      /^## Attack room/ { on = 1; next }
      /^## / { on = 0 }
      on && /^\|/ && !/^\| *Attack *\|/ && !/^\|[- |]+\|$/ && !/by construction/ && !/[1-9A-HJ-NP-Za-km-z]{43,44}/ { print NR ":" $0 }
    ' "$f")
  done
fi

echo "claims-lint: $violations violations"
[ "$violations" -eq 0 ]
