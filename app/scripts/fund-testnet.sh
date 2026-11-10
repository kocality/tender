#!/usr/bin/env bash
# Testnet only: put mock USDC into a bidder's NEAR Intents account, so the bid wizard can skip its deposit step.
# usage: TESTNET_TEAM_ACCOUNT=tender-<hex>.testnet TESTNET_USDC_ID=usdc-<hex>.testnet TESTNET_INTENTS_ID=intents-<hex>.testnet \
#        app/scripts/fund-testnet.sh <signerId> <micro-USDC>
# The team account's key comes from the near-cli-rs legacy keychain (~/.near-credentials/testnet); nothing is read from the repo.
# The mock token's `mint` is open to everyone, so the script mints first and then deposits with ft_transfer_call
# (msg = the Intents account that receives the credit).
set -euo pipefail

SIGNER="${1:?usage: fund-testnet.sh <signerId> <micro-USDC>}"
MICRO="${2:?usage: fund-testnet.sh <signerId> <micro-USDC>}"
TEAM="${TESTNET_TEAM_ACCOUNT:?set TESTNET_TEAM_ACCOUNT}"
USDC="${TESTNET_USDC_ID:?set TESTNET_USDC_ID}"
INTENTS="${TESTNET_INTENTS_ID:?set TESTNET_INTENTS_ID}"
case "$MICRO" in '' | *[!0-9]*) echo "micro-USDC must be a whole number" >&2; exit 1 ;; esac

call() { # call <receiver> <method> <json> <gas> <deposit>
  near contract call-function as-transaction "$1" "$2" json-args "$3" prepaid-gas "$4" attached-deposit "$5" \
    sign-as "$TEAM" network-config testnet sign-with-legacy-keychain send
}

balance() { # ft_balance_of of the team account, as a bare integer
  near contract call-function as-read-only "$USDC" ft_balance_of json-args "{\"account_id\":\"$TEAM\"}" \
    network-config testnet now 2>/dev/null | tr -dc '0-9'
}

have="$(balance || true)"
if [ -z "${have:-}" ] || [ "$have" -lt "$MICRO" ]; then
  call "$USDC" mint "{\"account_id\":\"$TEAM\",\"amount\":\"$MICRO\"}" '30 Tgas' '0 NEAR'
fi

call "$USDC" ft_transfer_call "{\"receiver_id\":\"$INTENTS\",\"amount\":\"$MICRO\",\"msg\":\"$SIGNER\"}" '100 Tgas' '1 yoctoNEAR'

echo "Intents balance of $SIGNER:"
near contract call-function as-read-only "$INTENTS" mt_balance_of json-args \
  "{\"account_id\":\"$SIGNER\",\"token_id\":\"nep141:$USDC\"}" network-config testnet now
