#!/usr/bin/env bash
# Records public mainnet responses used by the CLI unit tests (cli/test/fixtures/rpc/*.json).
# Only public views; no keys, no signing. Usage: bash cli/test/record-fixtures.sh
set -euo pipefail
cd "$(dirname "$0")"
out=fixtures/rpc
mkdir -p "$out"
RPC=${NEAR_RPC_URL:-https://free.rpc.fastnear.com}
USDC=nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1

b64() { printf '%s' "$1" | base64 | tr -d '\n'; }
rpc() { # rpc <file> <json-rpc params as {method, params}>
  curl -sS --max-time 20 -H 'content-type: application/json' -d "$2" "$RPC" > "$out/$1"
  echo "wrote $out/$1 ($(wc -c < "$out/$1" | tr -d ' ') B)"
}
view() { # view <file> <account> <method> <args json>
  rpc "$1" "{\"jsonrpc\":\"2.0\",\"id\":\"tender\",\"method\":\"query\",\"params\":{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$2\",\"method_name\":\"$3\",\"args_base64\":\"$(b64 "$4")\"}}"
}

view signer-version.json v1.signer version '{}'
view signer-state.json v1.signer state '{}'
view signer-public-key-2.json v1.signer public_key '{"domain_id":2}'
rpc signer-access-keys.json '{"jsonrpc":"2.0","id":"tender","method":"query","params":{"request_type":"view_access_key_list","finality":"final","account_id":"v1.signer"}}'
view intents-mt-batch-balance.json intents.near mt_batch_balance_of "{\"account_id\":\"tenderseal.near\",\"token_ids\":[\"$USDC\",\"nep141:wrap.near\"]}"
rpc unknown-account.json '{"jsonrpc":"2.0","id":"tender","method":"query","params":{"request_type":"view_account","finality":"final","account_id":"v1.tenderseal.near"}}'

curl -sS --max-time 20 "https://api.nearblocks.io/v3/accounts/ckd-auth.logunov.near/receipts?method=request_app_private_key&limit=2" > "$out/nearblocks-logunov.json"
echo "wrote $out/nearblocks-logunov.json"
curl -sS --max-time 20 "https://1click.chaindefuser.com/v0/status?depositAddress=0x0000000000000000000000000000000000000000" > "$out/oneclick-404.json"
echo "wrote $out/oneclick-404.json"
