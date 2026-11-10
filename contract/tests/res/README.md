# contract/tests/res/

## `defuse-0.4.5.wasm`

The exact code deployed at `intents.near` on mainnet, used by the sandbox tests so they run against the real Intents contract.

- Account: `intents.near` (mainnet)
- `code_hash`: `BtA1BEFNS619KkvXFsgcpQ21Tb5yMm32aaUkn7xNothk` (= base58 of the sha256 below)
- sha256: `a1afab98916d9f213746544dcf8e4e6bdb22c0be6bc5dfbd8ea8814c9922b547` (`defuse-0.4.5.wasm.sha256`)
- Size: 1,297,551 bytes
- `contract_source_metadata`: version `0.4.5`, source `https://github.com/near/intents/tree/16d04f6ec4401263f8914638710260da50bb46b0`
- Fetched: 2026-11-10T00:43Z, RPC `free.rpc.fastnear.com`, `view_code` at final block 223,842,626
- License: MIT (near/intents)

Fetch command (run from the repo root):

```sh
curl -s https://free.rpc.fastnear.com -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_code","finality":"final","account_id":"intents.near"}}' \
| python3 -c 'import sys,json,base64;r=json.load(sys.stdin)["result"];open("contract/tests/res/defuse-0.4.5.wasm","wb").write(base64.b64decode(r["code_base64"]));print(r["hash"])'
(cd contract/tests/res && shasum -a 256 -c defuse-0.4.5.wasm.sha256)
```

If `intents.near` is upgraded, the hash above no longer matches mainnet. Do not replace the file silently: the tests must run against the code that is live on mainnet.
