#!/bin/bash
# Boot the local MagicBlock stack (base validator :8899 + ephemeral rollup :7799)
# with solsocket-engine preloaded, then hold until killed.
#
#   npm i -g @magicblock-labs/ephemeral-validator   # once
#   ./scripts/local-stack.sh                        # terminal 1
#   pnpm --filter @solsocket/program test:local     # terminal 2
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SO="$REPO_ROOT/program/target/deploy/solsocket_engine.so"
KP="$REPO_ROOT/program/target/deploy/solsocket_engine-keypair.json"
WALLET_PUBKEY=$(solana-keygen pubkey "$HOME/.config/solana/id.json")

[ -f "$SO" ] || { echo "Build first: cd program && anchor build"; exit 1; }

command -v mb-stack >/dev/null || {
  echo "mb-stack not found. Install with: npm i -g @magicblock-labs/ephemeral-validator"
  exit 1
}

# The ER validator identity must hold >=5 SOL on the base layer or it refuses
# to start; preload it as a genesis account.
exec mb-stack --reset \
  --upgradeable-program "$KP" "$SO" "$WALLET_PUBKEY" \
  --account - "$REPO_ROOT/scripts/fixtures/er-validator-identity.json"
