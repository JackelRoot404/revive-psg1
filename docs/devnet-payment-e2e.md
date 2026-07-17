# Devnet payment E2E

This standalone test creates a fresh payer, reference, and six-decimal token mint on canonical Solana devnet. It mints exactly 29 test tokens, transfers them to the associated token account owned by the configured Revive treasury public key, waits for finalization, and runs the API payment invariants against the parsed transaction.

No mainnet token or treasury private key is used. The temporary payer key is deleted at the end. The development validator requires both `REVIVE_DEVNET_PAYMENT_E2E=1` and the canonical devnet genesis hash. The production verifier is also run and must reject the ephemeral mint as non-official USDC.

Requirements:

- `solana`, `solana-keygen`, and `spl-token` on `PATH`
- Node dependencies installed
- A working devnet RPC
- Either a working faucet or an explicitly selected, devnet-funded keypair

Run with the faucet:

```sh
npm run test:payment:devnet
```

The public faucet is often rate limited. In that case, fund the ephemeral payer from an existing **devnet-only** keypair:

```sh
DEVNET_FUNDING_KEYPAIR="$HOME/.config/solana/id.json" npm run test:payment:devnet
```

Optionally select a different devnet RPC:

```sh
SOLANA_DEVNET_RPC="https://your-devnet-rpc.example" DEVNET_FUNDING_KEYPAIR="/path/to/devnet.json" npm run test:payment:devnet
```

The script prints a JSON result containing the transaction signature and devnet Explorer URL. It never prints private key material.

This is a payment-verifier integration test, not a substitute for the complete signed browser-wallet, database, license-issuance, and desktop-claim E2E required before enabling public sales.
