# Devnet payment E2E evidence — 2026-07-16

Result: **passed** against canonical public Solana devnet.

- Genesis: `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`
- Amount: `29,000,000` base units of a fresh six-decimal test mint
- Treasury owner: `EAjkNpwau3hB58C2M4U8rQWFANHRidA8XiB4Dvq78T4y`
- Ephemeral mint: `DsrEY9PczaPFK48qKNTSybE6JZz3GQ2azpRosk7WxJkr`
- Order reference: `2MwSwhLqJ3FLJuakqZy2PrkVf4fz12mihPR5Pk57H5pS`
- Transaction: [`4bDAiLHVSML1KdkK5u6bjmYWar9h4EWbh9WTj2xrG4b3HW6s5SjY1ERMqZYwyqBJVCNpSv9NPfKqqEVc8FrAn3xH`](https://explorer.solana.com/tx/4bDAiLHVSML1KdkK5u6bjmYWar9h4EWbh9WTj2xrG4b3HW6s5SjY1ERMqZYwyqBJVCNpSv9NPfKqqEVc8FrAn3xH?cluster=devnet)
- Finalized transaction accepted by the devnet-gated invariant validator
- The production verifier rejected the ephemeral mint with `WRONG_MINT`

The public faucet was rate limited. A pre-existing devnet-only CLI keypair funded the temporary payer with devnet SOL. No mainnet funds or treasury signing keys were used.

## Defect found and corrected

The first public-devnet preflight rejected the checkout transaction because the order reference had been attached as a readonly non-signer to the Memo instruction. Solana Memo requires every supplied account to sign. The reference now appears as an additional readonly account on the SPL token transfer, while the Memo instruction has no accounts. A regression test enforces this layout.

This evidence covers public-network transaction construction, finalization, exact payer/treasury token deltas, payer signature, unique reference presence, and strict production-mint rejection. It does not yet cover the entire browser-wallet/database/license/desktop flow.
