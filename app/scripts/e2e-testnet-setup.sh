#!/usr/bin/env bash
# Testnet only: put 0.1 mock wNEAR of supply into the team's Intents account and create a fresh short sale on the
# testnet copy, then write the ids the end-to-end test reads.
# usage: TESTNET_PREFIX=<6 hex> app/scripts/e2e-testnet-setup.sh        (run from the repository root)
#   E2E_CLOSE_SECS  seconds from now to the sale's close (default 420; the contract accepts 300 s to 30 days)
#   E2E_OUT_DIR     where the env file goes (default: $TMPDIR/tender-e2e)
#   E2E_ENV_FILE    name of the env file inside it (default e2e-testnet.env)
#   TESTNET_USDC_ID / TESTNET_WNEAR_ID override the mock token ids (default usdc.tender-<hex>.testnet / wnear.tender-<hex>.testnet)
# The team account's key comes from the near-cli-rs legacy keychain (~/.near-credentials/testnet). Nothing secret is written.
set -euo pipefail

H="${TESTNET_PREFIX:?set TESTNET_PREFIX=<6 hex>}"
TEAM="tender-$H.testnet"
INTENTS="intents-$H.testnet"
TENDER="v1.tender-$H.testnet"
USDC="${TESTNET_USDC_ID:-usdc.$TEAM}"
WNEAR="${TESTNET_WNEAR_ID:-wnear.$TEAM}"
RPC="${TESTNET_RPC:-https://test.rpc.fastnear.com}"
SUPPLY=100000000000000000000000 # 0.1 wNEAR (24 decimals)
CLOSE_SECS="${E2E_CLOSE_SECS:-420}"
OUT="${E2E_OUT_DIR:-${TMPDIR:-/tmp}/tender-e2e}"
mkdir -p "$OUT"

view() { # view <account> <method> <args json> -> decoded JSON result
  local args; args="$(printf '%s' "$3" | base64 | tr -d '\n')"
  curl -sS --retry 3 "$RPC" -H 'Content-Type: application/json' -d \
    "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$1\",\"method_name\":\"$2\",\"args_base64\":\"$args\"}}" |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);if(j.error||j.result.error){console.error(JSON.stringify(j.error||j.result.error));process.exit(1)}console.log(Buffer.from(j.result.result).toString())})'
}
call() { # call <receiver> <method> <json> <gas> <deposit>
  near contract call-function as-transaction "$1" "$2" json-args "$3" prepaid-gas "$4" attached-deposit "$5" \
    sign-as "$TEAM" network-config testnet sign-with-legacy-keychain send
}
big_ge() { node -e "process.exit(BigInt(process.argv[1]) >= BigInt(process.argv[2]) ? 0 : 1)" "$1" "$2"; }

echo "== 1 get_config of $TENDER"
CFG="$(view "$TENDER" get_config '{}')"
echo "$CFG" | jq -c '{version, app_pk_mode, intents, mpc, quote_tokens, sellers, sales}'
[ "$(echo "$CFG" | jq -r .intents)" = "$INTENTS" ] || { echo "FAIL: the contract points at a different intents account" >&2; exit 1; }
[ "$(echo "$CFG" | jq -r '.quote_tokens[0]')" = "nep141:$USDC" ] || { echo "FAIL: quote token is not nep141:$USDC" >&2; exit 1; }
[ "$(echo "$CFG" | jq -r '.sellers | index("'"$TEAM"'")')" != "null" ] || { echo "FAIL: $TEAM is not a seller" >&2; exit 1; }

echo "== 2 supply: $TEAM needs $SUPPLY of nep141:$WNEAR in $INTENTS"
bal="$(view "$INTENTS" mt_balance_of "{\"account_id\":\"$TEAM\",\"token_id\":\"nep141:$WNEAR\"}" | tr -d '"')"
if ! big_ge "$bal" "$SUPPLY"; then
  have="$(view "$WNEAR" ft_balance_of "{\"account_id\":\"$TEAM\"}" | tr -d '"')"
  if ! big_ge "$have" "$SUPPLY"; then
    call "$WNEAR" mint "{\"account_id\":\"$TEAM\",\"amount\":\"1000000000000000000000000\"}" '30 Tgas' '0 NEAR'
  fi
  call "$WNEAR" ft_transfer_call "{\"receiver_id\":\"$INTENTS\",\"amount\":\"$SUPPLY\",\"msg\":\"\"}" '100 Tgas' '1 yoctoNEAR'
  bal="$(view "$INTENTS" mt_balance_of "{\"account_id\":\"$TEAM\",\"token_id\":\"nep141:$WNEAR\"}" | tr -d '"')"
fi
big_ge "$bal" "$SUPPLY" || { echo "FAIL: Intents wNEAR balance of $TEAM is $bal" >&2; exit 1; }
echo "intents wNEAR balance of $TEAM = $bal"

echo "== 3 create a sale (reserve 3.00, min_escrow 1, min_bidders 1, max_bids 8, close in ${CLOSE_SECS}s)"
before="$(echo "$CFG" | jq -r .sales)"
close_ns="$(node -e "console.log((BigInt(Date.now()) * 1000000n + BigInt(process.argv[1]) * 1000000000n).toString())" "$CLOSE_SECS")"
msg="$(jq -c -n --arg c "$close_ns" --arg u "nep141:$USDC" \
  '{op:"create", close_ns:$c, reveal_secs:"86400", reserve:"3000000", min_escrow:"1000000", min_bidders:1, quote_token:$u, max_bids:8, decimals:24, lot_exp:0}')"
args="$(jq -c -n --arg r "$TENDER" --arg t "nep141:$WNEAR" --arg a "$SUPPLY" --arg m "$msg" '{receiver_id:$r, token_id:$t, amount:$a, msg:$m}')"
call "$INTENTS" mt_transfer_call "$args" '100 Tgas' '1 yoctoNEAR' | tee "${TMPDIR:-/tmp}/e2e-create.log" | grep -E 'Transaction ID|Gas burnt' || true
after="$(view "$TENDER" get_config '{}' | jq -r .sales)"
[ "$after" -gt "$before" ] || { echo "FAIL: create was refunded (sales $before -> $after)" >&2; exit 1; }
SALE_ID=$((after - 1))
sale="$(view "$TENDER" get_sale "{\"id\":\"$SALE_ID\"}")"
echo "$sale" | jq -c '{id, state, path, close_ns, supply, reserve, min_escrow, min_bidders}'

ENV_FILE="$OUT/${E2E_ENV_FILE:-e2e-testnet.env}"
echo "== 4 write $ENV_FILE"
{
  echo "E2E_SALE_ID=$SALE_ID"
  echo "E2E_TENDER=$TENDER"
  echo "E2E_INTENTS=$INTENTS"
  echo "E2E_USDC=$USDC"
  echo "E2E_TEAM=$TEAM"
  echo "E2E_CLOSE_NS=$(echo "$sale" | jq -r .close_ns)"
} >"$ENV_FILE"
cat "$ENV_FILE"
