#!/usr/bin/env bash
# Testnet rehearsal of a whole Tender sale, free and without any wallet:
#   own copy of the intents.near 0.4.5 wasm + two mock NEP-141 tokens (USDC 6 dec, wNEAR 24 dec),
#   keyless birth of v1.tender-<H>.testnet (relayer/scripts/birth.ts), a team-funded sale,
#   two sealed bids (pnpm seal:bid), open() -> real CKD from v1.signer-prod.testnet ->
#   decrypt (pnpm verify) -> reveal -> finalize -> payouts -> balances -> pnpm verify.
#
# Usage (repo root): bash contract/scripts/testnet-rehearsal.sh
#   STEP=<n>  resume at step n (state in contract/scripts/out/m3-state.json: public account ids and tx hashes only)
#   H=<6 hex> account suffix for a fresh run (default: from the state file, else random)
#   MODE=identity|generator|plain  app_pk_mode for new() (default generator, CRYPTO-07)
#   EXTRA_FUND=<testnet account in the keychain>  tops up the intents copy when fund1 is not there
#   NEAR_NETCFG=<near-cli network-config name>  (default testnet), e.g. one that points at a less busy RPC
# Accounts: three faucet accounts (tender-, intents-, fund1-<H>.testnet; the faucet rate-limits per IP) and
# four subaccounts of tender-<H> funded by it: usdc., wnear., bidder1., bidder2.
# Keys: near-cli-rs legacy keychain, ~/.near-credentials/testnet/ (never in the repo). Secret bid files:
# ~/.tender/bids/ (written by seal:bid). Raw near-cli logs go to $TMPDIR/tender-m3/.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
OUT=contract/scripts/out
STATE="$OUT/m3-state.json"
LOGS="${TMPDIR:-/tmp}/tender-m3"
RPC="${TESTNET_RPC:-https://test.rpc.fastnear.com}"
STEP="${STEP:-1}"
MPC=v1.signer-prod.testnet
MPC_PK=bls12381g2:xeYho48G2Sr9oJz4gw9sLGZGspeeKpHZvMDAwWvoNTRnVMFJH96GxX98TT2MRhTtsot1wcGR1Ti2Xh8PCsbYJ2enbLNdJXDvTYSK8aTE3nJ5NZXU7Kt1F6mFtReWs5pR4kj
WASM=contract/target/near/tender.wasm
FT_WASM=contract/tests/mock-ft/target/near/mock_ft.wasm
DEFUSE_WASM=contract/tests/res/defuse-0.4.5.wasm
C25_NEAR=4.5
NETCFG="${NEAR_NETCFG:-testnet}"
mkdir -p "$OUT" "$LOGS"

if [ -f "$STATE" ] && [ -z "${H:-}" ]; then H="$(jq -r .h "$STATE")"; fi
H="${H:-$(openssl rand -hex 3)}"
MODE="${MODE:-generator}"
TENDER="tender-$H.testnet" INTENTS="intents-$H.testnet" FUND1="fund1-$H.testnet"
USDC="usdc.$TENDER" WNEAR="wnear.$TENDER" B1="bidder1.$TENDER" B2="bidder2.$TENDER" V1="v1.$TENDER"
if [ ! -f "$STATE" ]; then
  jq -n --arg h "$H" --arg mode "$MODE" --arg mpc "$MPC" \
    '{h:$h, network:"testnet", app_pk_mode:$mode, mpc:$mpc, seller_wnear_deposit:"100000000000000000000000", tx:{}}' >"$STATE"
fi
[ "$(jq -r .h "$STATE")" = "$H" ] || { echo "state file is for H=$(jq -r .h "$STATE"), not $H" >&2; exit 1; }

say() { printf '\n== %s\n' "$*"; }
setj() { local t; t="$(mktemp)"; jq "$@" "$STATE" >"$t" && mv "$t" "$STATE"; }
setj --arg t "$TENDER" --arg i "$INTENTS" --arg u "$USDC" --arg w "$WNEAR" --arg b1 "$B1" --arg b2 "$B2" --arg v1 "$V1" \
  '.accounts = {tender:$t, intents:$i, usdc:$u, wnear:$w, v1:$v1,
                bidders:[{id:$b1, usdc_deposit:"5000000"},{id:$b2, usdc_deposit:"5000000"}]}'

rpc() { # rpc <method> <params json> -> result json
  curl -sS --retry 3 "$RPC" -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":$2}"
}
view() { # view <account> <method> <args json> -> decoded JSON result
  local args; args="$(printf '%s' "$3" | base64 | tr -d '\n')"
  rpc query "{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$1\",\"method_name\":\"$2\",\"args_base64\":\"$args\"}" |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);if(j.error||j.result.error){console.error(JSON.stringify(j.error||j.result.error));process.exit(1)}console.log(Buffer.from(j.result.result).toString())})'
}
balance_near() { # whole account balance in NEAR (decimal), empty if the account does not exist
  rpc query "{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$1\"}" |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);if(j.result&&j.result.amount)console.log((Number(BigInt(j.result.amount)/10n**18n)/1e6).toString())})'
}
has_code() { # 0 if the account has a contract deployed
  rpc query "{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$1\"}" |
    jq -e '.result.code_hash and .result.code_hash != "11111111111111111111111111111111"' >/dev/null
}
chain_ns() { rpc block '{"finality":"final"}' | jq -r .result.header.timestamp_nanosec; }

ntx() { # ntx <label> <near args...>: run near-cli-rs, record the tx hash under .tx[label]
  local label="$1"; shift
  local log="$LOGS/$label.log" try
  # An RPC rate-limit refusal comes before anything is sent (no tx hash in the log): retry it.
  for try in 1 2 3 4 5 6; do
    if near "$@" >"$log" 2>&1; then break; fi
    if [ "$try" -lt 6 ] && grep -qi 'rate limit' "$log" && ! grep -q 'Transaction ID:' "$log"; then
      echo "$label: RPC rate limit, retry $try in ${NTX_RETRY_SECS:-15} s" >&2; sleep "${NTX_RETRY_SECS:-15}"; continue
    fi
    tail -20 "$log" >&2; echo "FAILED: $label (log $log)" >&2; exit 1
  done
  local hash; hash="$(grep -Eo 'Transaction ID: [1-9A-HJ-NP-Za-km-z]{43,44}' "$log" | tail -1 | awk '{print $3}')"
  if [ -z "$hash" ]; then tail -20 "$log" >&2; echo "no tx hash in output: $label" >&2; exit 1; fi
  if grep -qiE 'Failure|panicked|Smart contract panicked' "$log"; then
    tail -20 "$log" >&2; echo "FAILED: $label tx $hash" >&2; exit 1
  fi
  setj --arg l "$label" --arg h "$hash" '.tx[$l] = $h'
  echo "$label tx $hash"
}
call() { # call <label> <signer> <receiver> <method> <json> <gas> <deposit>
  ntx "$1" contract call-function as-transaction "$3" "$4" json-args "$5" prepaid-gas "$6" attached-deposit "$7" \
    sign-as "$2" network-config "$NETCFG" sign-with-legacy-keychain send
}

if [ "$STEP" -le 1 ]; then
  say "1 accounts (H=$H): faucet, then subaccounts of $TENDER"
  for a in tender intents fund1; do
    id="$a-$H.testnet"
    if [ -f "$HOME/.near-credentials/testnet/$id.json" ] && [ -n "$(balance_near "$id")" ]; then echo "$id exists"; continue; fi
    for try in $(seq 30); do
      # A key file left by an interrupted run for an account that does not exist would shadow the new key.
      if [ -z "$(balance_near "$id")" ] && [ -e "$HOME/.near-credentials/testnet/$id.json" ]; then
        mkdir -p "$LOGS/stale-keys" && mv "$HOME/.near-credentials/testnet/$id.json" "$HOME/.near-credentials/testnet/$id" "$LOGS/stale-keys/" 2>/dev/null || true
      fi
      if near account create-account sponsor-by-faucet-service "$id" autogenerate-new-keypair \
        save-to-legacy-keychain network-config "$NETCFG" create >"$LOGS/create-$a.log" 2>&1; then break; fi
      grep -q '429' "$LOGS/create-$a.log" || { tail -20 "$LOGS/create-$a.log" >&2; exit 1; }
      [ "$a" = fund1 ] && [ -n "${EXTRA_FUND:-}" ] && { echo "faucet 429 for $id: EXTRA_FUND=$EXTRA_FUND tops up instead"; continue 2; }
      echo "faucet 429 for $id, retry $try/30 in 120 s"; sleep 120
    done
    sleep 3
    hash="$(grep -Eo 'Transaction ID: [1-9A-HJ-NP-Za-km-z]{43,44}' "$LOGS/create-$a.log" | tail -1 | awk '{print $3}')"
    [ -n "$hash" ] && [ -n "$(balance_near "$id")" ] || { tail -20 "$LOGS/create-$a.log" >&2; echo "FAILED: create $id" >&2; exit 1; }
    setj --arg l "create-$a" --arg h "$hash" '.tx[$l] = $h'
    echo "create-$a tx $hash"
    sleep 10
  done
  for sub in "$USDC:1.5" "$WNEAR:1.5" "$B1:0.3" "$B2:0.3"; do
    IFS=: read -r id amt <<<"$sub"
    if [ -n "$(balance_near "$id")" ]; then echo "$id exists"; continue; fi
    ntx "create-${id%%.*}" account create-account fund-myself "$id" "$amt NEAR" autogenerate-new-keypair \
      save-to-legacy-keychain sign-as "$TENDER" network-config "$NETCFG" sign-with-legacy-keychain send
  done
  echo "$TENDER balance: $(balance_near "$TENDER") NEAR · $INTENTS balance: $(balance_near "$INTENTS") NEAR"
fi

if [ "$STEP" -le 2 ]; then
  say "2 storage for the intents copy (target >= 15 NEAR)"
  have="$(balance_near "$INTENTS")"
  if ! node -e "process.exit(Number('$have') >= 15 ? 0 : 1)"; then
    if [ -n "$(balance_near "$FUND1")" ]; then
      x="$(node -e "console.log(Math.floor((Number('$(balance_near "$FUND1")') - 0.5) * 100) / 100)")"
      ntx fund-fund1 tokens "$FUND1" send-near "$INTENTS" "$x NEAR" network-config "$NETCFG" sign-with-legacy-keychain send
    else
      [ -n "${EXTRA_FUND:-}" ] || { echo "FAIL: $FUND1 does not exist and EXTRA_FUND is not set" >&2; exit 1; }
      x="$(node -e "console.log(Math.ceil((15.2 - Number('$have')) * 100) / 100)")"
      ntx fund-extra tokens "$EXTRA_FUND" send-near "$INTENTS" "$x NEAR" network-config "$NETCFG" sign-with-legacy-keychain send
      setj --arg f "$EXTRA_FUND" '.extra_fund = $f'
    fi
  fi
  echo "$INTENTS balance: $(balance_near "$INTENTS") NEAR"
fi

if [ "$STEP" -le 3 ]; then
  say "3 mock FTs"
  for t in "$USDC:6:USDC" "$WNEAR:24:WNEAR"; do
    IFS=: read -r id dec sym <<<"$t"
    if has_code "$id"; then echo "$id already deployed"; continue; fi
    ntx "deploy-$(echo "$sym" | tr "[:upper:]" "[:lower:]")" contract deploy "$id" use-file "$FT_WASM" with-init-call new \
      json-args "{\"owner_id\":\"$TENDER\",\"decimals\":$dec,\"symbol\":\"$sym\"}" prepaid-gas '100 Tgas' attached-deposit '0 NEAR' \
      network-config "$NETCFG" sign-with-legacy-keychain send
  done
fi

if [ "$STEP" -le 4 ]; then
  say "4 intents 0.4.5 copy"
  if ! has_code "$INTENTS"; then
    ntx deploy-intents contract deploy "$INTENTS" use-file "$DEFUSE_WASM" with-init-call new \
      json-args "{\"config\":{\"wnear_id\":\"$WNEAR\",\"fees\":{\"fee\":0,\"fee_collector\":\"$TENDER\"},\"roles\":{}}}" \
      prepaid-gas '300 Tgas' attached-deposit '0 NEAR' network-config "$NETCFG" sign-with-legacy-keychain send
  fi
  echo "current_salt: $(view "$INTENTS" current_salt '{}')"
fi

if [ "$STEP" -le 5 ]; then
  say "5 register, mint, deposit into the intents copy"
  call reg-usdc "$TENDER" "$USDC" storage_deposit "{\"account_id\":\"$INTENTS\",\"registration_only\":true}" '30 Tgas' '0.00125 NEAR'
  call reg-wnear "$TENDER" "$WNEAR" storage_deposit "{\"account_id\":\"$INTENTS\",\"registration_only\":true}" '30 Tgas' '0.00125 NEAR'
  call mint-wnear "$TENDER" "$WNEAR" mint "{\"account_id\":\"$TENDER\",\"amount\":\"1000000000000000000000000\"}" '30 Tgas' '0 NEAR'
  for b in "$B1" "$B2"; do
    call "mint-usdc-${b%%.*}" "$TENDER" "$USDC" mint "{\"account_id\":\"$b\",\"amount\":\"10000000\"}" '30 Tgas' '0 NEAR'
  done
  call deposit-seller "$TENDER" "$WNEAR" ft_transfer_call \
    "{\"receiver_id\":\"$INTENTS\",\"amount\":\"$(jq -r .seller_wnear_deposit "$STATE")\",\"msg\":\"\"}" '100 Tgas' '1 yoctoNEAR'
  for b in "$B1" "$B2"; do
    call "deposit-${b%%.*}" "$b" "$USDC" ft_transfer_call "{\"receiver_id\":\"$INTENTS\",\"amount\":\"5000000\",\"msg\":\"\"}" '100 Tgas' '1 yoctoNEAR'
  done
  for a in "$TENDER:$WNEAR" "$B1:$USDC" "$B2:$USDC"; do
    IFS=: read -r who tok <<<"$a"
    q="{\"account_id\":\"$who\",\"token_id\":\"nep141:$tok\"}"
    bal="$(view "$INTENTS" mt_balance_of "$q")"
    echo "$who intents balance nep141:$tok = $bal"
  done
fi

if [ "$STEP" -le 6 ]; then
  say "6 keyless birth of $V1 (app_pk_mode $MODE)"
  jq -n --arg i "$INTENTS" --arg mode "$MODE" --arg pk "$MPC_PK" --arg u "nep141:$USDC" --arg t "$TENDER" --arg mpc "$MPC" \
    '{mpc:$mpc, intents:$i, domain_id:2, app_pk_mode:$mode, mpc_public_key:$pk, quote_tokens:[$u], sellers:[$t]}' >"$OUT/m3-init.json"
  if [ -z "$(balance_near "$V1")" ]; then
    pnpm --filter @tender/relayer exec tsx scripts/birth.ts --network testnet --signer "$TENDER" --account "$V1" \
      --wasm "../$WASM" --balance "$C25_NEAR" --init "$ROOT/$OUT/m3-init.json" --yes | tee "$LOGS/birth.log"
    hash="$(grep -Eo 'tx=[1-9A-HJ-NP-Za-km-z]{43,44}' "$LOGS/birth.log" | head -1 | cut -d= -f2)"
    [ -n "$hash" ] || { echo "birth: no tx hash" >&2; exit 1; }
    setj --arg h "$hash" '.tx.birth = $h'
  fi
  keys="$(rpc query "{\"request_type\":\"view_access_key_list\",\"finality\":\"final\",\"account_id\":\"$V1\"}" | jq -c .result.keys)"
  echo "access keys of $V1: $keys"
  [ "$keys" = "[]" ] || { echo "FAIL: $V1 has access keys" >&2; exit 1; }
  setj --argjson k "$keys" '.access_keys_v1 = $k'
  view "$V1" get_config '{}'
fi

if [ "$STEP" -le 7 ]; then
  say "7 create sale 0 (0.1 wNEAR, reserve 3.00, min_escrow 2, min_bidders 2, close now + 6 min)"
  if [ "$(view "$V1" get_sale '{"id":"0"}')" = "null" ]; then
    close_ns="$(node -e "console.log((BigInt(Date.now()) * 1000000n + 360n * 1000000000n).toString())")"
    msg="$(jq -c -n --arg c "$close_ns" --arg u "nep141:$USDC" \
      '{op:"create", close_ns:$c, reveal_secs:"86400", reserve:"3000000", min_escrow:"2000000", min_bidders:2,
        quote_token:$u, max_bids:8, decimals:24, lot_exp:0}')"
    args="$(jq -c -n --arg r "$V1" --arg t "nep141:$WNEAR" --arg a "$(jq -r .seller_wnear_deposit "$STATE")" --arg m "$msg" \
      '{receiver_id:$r, token_id:$t, amount:$a, msg:$m}')"
    call create "$TENDER" "$INTENTS" mt_transfer_call "$args" '100 Tgas' '1 yoctoNEAR'
  fi
  sale="$(view "$V1" get_sale '{"id":"0"}')"
  [ "$sale" != "null" ] || { echo "FAIL: create was refunded (see $LOGS/create.log)" >&2; exit 1; }
  echo "$sale" | jq -c '{id, state, path, close_ns, supply}'
  setj --argjson s "$(echo "$sale" | jq '{id, path, close_ns, created_block}')" '.sale = $s'
fi

if [ "$STEP" -le 8 ]; then
  say "8 two sealed bids (seal:bid --network testnet, mt_transfer_call 2 USDC each)"
  i=0
  for spec in "$B1:3.9" "$B2:3.6"; do
    i=$((i + 1))
    IFS=: read -r who price <<<"$spec"
    if [ "$(view "$V1" get_bids '{"id":"0","from":0,"limit":64}' | jq --arg w "$who" '[.[] | select(.bidder == $w)] | length')" != "0" ]; then
      echo "$who already bid"; continue
    fi
    pnpm --silent seal:bid --network testnet --contract "$V1" --sale 0 --price "$price" --size 1 --escrow 2 \
      --signer "$who" --origin near --no-payload >"$OUT/m3-bid$i.json"
    args="$(jq -c -n --arg r "$V1" --arg t "nep141:$USDC" --arg m "$(jq -r .msg "$OUT/m3-bid$i.json")" \
      '{receiver_id:$r, token_id:$t, amount:"2000000", msg:$m}')"
    call "bid$i" "$who" "$INTENTS" mt_transfer_call "$args" '100 Tgas' '1 yoctoNEAR'
  done
  view "$V1" get_sale '{"id":"0"}' | jq -c '{state, bids, bidders, escrow_total}'
  [ "$(view "$V1" get_sale '{"id":"0"}' | jq .bids)" = "2" ] || { echo "FAIL: expected 2 bids" >&2; exit 1; }
fi

if [ "$STEP" -le 9 ]; then
  say "9 wait for close, open(0), wait for the testnet MPC key"
  close_ns="$(jq -r .sale.close_ns "$STATE")"
  until node -e "process.exit(BigInt('$(chain_ns)') >= BigInt('$close_ns') ? 0 : 1)"; do sleep 30; done
  for attempt in 1 2; do
    state="$(view "$V1" get_sale '{"id":"0"}' | jq -r .state)"
    [ "$state" = "Keyed" ] && break
    if [ "$state" = "Open" ]; then call "open$attempt" "$TENDER" "$V1" open '{"sale":"0"}' '100 Tgas' '0 NEAR'; fi
    for _ in $(seq 30); do
      state="$(view "$V1" get_sale '{"id":"0"}' | jq -r .state)"
      [ "$state" = "Keyed" ] || [ "$state" = "Open" ] && break
      sleep 10
    done
    echo "state after open attempt $attempt: $state"
  done
  [ "$state" = "Keyed" ] || { echo "FAIL: no key after two open attempts (see get_key_log)" >&2; view "$V1" get_key_log '{"from":"0","limit":100}' >&2; exit 1; }
  log="$(view "$V1" get_key_log '{"from":"0","limit":100}')"
  echo "key_log: $log"
  setj --argjson l "$log" '.key_log = $l | .ckd_latency_blocks = ([$l[] | select(.outcome == "Ok") | ((.resolved_block | tonumber) - (.block | tonumber))] | first)'
  echo "CKD latency (blocks): $(jq .ckd_latency_blocks "$STATE")"
fi

if [ "$STEP" -le 10 ]; then
  say "10 real decryption (verify, before reveal: only #12 and #13 matter here)"
  pnpm --silent verify --network testnet --contract "$V1" --sale 0 --wasm "$WASM" | tee "$OUT/m3-verify-prereveal.txt" || true
  grep -E '^PASS #12 ' "$OUT/m3-verify-prereveal.txt" && grep -E '^PASS #13 ' "$OUT/m3-verify-prereveal.txt" ||
    { echo "FAIL: #12/#13 did not pass before reveal" >&2; exit 1; }
fi

if [ "$STEP" -le 11 ]; then
  say "11 reveal from the local secret bid files, finalize, payouts"
  if [ "$(view "$V1" get_sale '{"id":"0"}' | jq .revealed)" != "2" ]; then
    items="$(node contract/scripts/m3-reveal-items.mjs --network testnet --contract "$V1" --sale 0 \
      --bids-glob "$HOME/.tender/bids/testnet-$V1-sale0-*.json")"
    call reveal "$TENDER" "$V1" reveal "$items" '100 Tgas' '0 NEAR'
  fi
  for n in 1 2 3; do
    s="$(view "$V1" get_sale '{"id":"0"}')"
    if [ "$(echo "$s" | jq -r .state)" = "Finalized" ] && [ "$(echo "$s" | jq '.payouts_done == .payouts_total')" = "true" ]; then break; fi
    call "finalize$n" "$TENDER" "$V1" finalize '{"sale":"0","max":8}' '300 Tgas' '0 NEAR'
  done
  view "$V1" get_sale '{"id":"0"}' | jq -c '{state, revealed, payouts_done, payouts_total, seller_payout}'
  view "$V1" get_result '{"id":"0"}' | jq -c .
fi

if [ "$STEP" -le 12 ]; then
  say "12 balances vs the local TS clearing"
  node_modules/.bin/tsx contract/scripts/m3-balances.ts "$STATE" | tee "$OUT/m3-balances.txt"
fi

if [ "$STEP" -le 13 ]; then
  say "13 full verify"
  pnpm --silent verify --network testnet --contract "$V1" --sale 0 --wasm "$WASM" | tee "$OUT/m3-verify.txt" || true
  pnpm --silent verify --keys --network testnet --contract "$V1" | tee "$OUT/m3-verify-keys.txt" || true
  if grep -q '^FAIL' "$OUT/m3-verify.txt" "$OUT/m3-verify-keys.txt"; then echo "FAIL lines in verify output" >&2; exit 1; fi
fi

if [ "$STEP" -le 14 ]; then
  say "14 summary"
  utc="$(date -u +%Y%m%dT%H%MZ)"
  jq --arg utc "$utc" --arg last "$(tail -1 "$OUT/m3-verify.txt")" --arg keys "$(tail -1 "$OUT/m3-verify-keys.txt")" \
    --arg bal "$(tail -1 "$OUT/m3-balances.txt")" --arg wasm "$(shasum -a 256 "$WASM" | cut -d' ' -f1)" \
    '{run_utc:$utc, network, app_pk_mode, mpc, wasm_sha256:$wasm, accounts, sale, access_keys_v1, key_log,
      ckd_latency_blocks, extra_fund, tx, balances:$bal, verify_last_line:$last, verify_keys_last_line:$keys,
      explorer:"https://testnet.nearblocks.io/txns/<hash>"}' "$STATE" >"$OUT/m3-$utc.json"
  echo "summary: $OUT/m3-$utc.json"
fi
