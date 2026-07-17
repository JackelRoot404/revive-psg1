import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import bs58 from "bs58";
import { SOLANA_USDC_MINT, USDC_AMOUNT_BASE_UNITS } from "@revive-psg1/contracts";
import {
  SOLANA_DEVNET_GENESIS_HASH,
  SolanaPaymentVerifier,
  validateDevnetPaymentTransactionForE2E,
  type ParsedPaymentTransaction
} from "./payment";
import type { Config } from "./config";

const payer = address();
const treasury = address();
const reference = address();
const verifier = new SolanaPaymentVerifier({ solanaRpcPrimary: "http://localhost:8899" } as Config);

function address(): string { return bs58.encode(randomBytes(32)); }
function transaction(treasuryAmount = USDC_AMOUNT_BASE_UNITS, mint = SOLANA_USDC_MINT): ParsedPaymentTransaction {
  return {
    slot: 1, blockTime: 1,
    transaction: { message: {
      accountKeys: [
        { pubkey: payer, signer: true, writable: true },
        { pubkey: treasury, signer: false, writable: true },
        { pubkey: reference, signer: false, writable: false }
      ]
    } },
    meta: {
      err: null,
      preTokenBalances: [balance(0, payer, 40_000_000n, mint), balance(1, treasury, 0n, mint)],
      postTokenBalances: [balance(0, payer, 40_000_000n - treasuryAmount, mint), balance(1, treasury, treasuryAmount, mint)],
    }
  };
}
function balance(accountIndex: number, owner: string, amount: bigint, mint: string) {
  return { accountIndex, mint, owner, programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", uiTokenAmount: { amount: amount.toString(), decimals: 6, uiAmount: Number(amount) / 1e6, uiAmountString: (Number(amount) / 1e6).toString() } };
}

describe("Solana payment validation", () => {
  it("accepts exact official-USDC payer and treasury deltas with reference", () => expect(() => verifier.validateTransaction(transaction(), { transactionSignature: "sig", payer, treasury, reference })).not.toThrow());
  it("rejects an overpayment instead of silently licensing it", () => expect(() => verifier.validateTransaction(transaction(USDC_AMOUNT_BASE_UNITS + 1n), { transactionSignature: "sig", payer, treasury, reference })).toThrow(/exact USDC amount/));
  it("rejects a database/order amount that differs from the fixed public price", () => expect(() => verifier.validateTransaction(transaction(), { transactionSignature: "sig", payer, treasury, reference, amountBaseUnits: USDC_AMOUNT_BASE_UNITS - 1n })).toThrow(/fixed 29 USDC price/));
  it("rejects any non-official mint even if balances otherwise match", () => expect(() => verifier.validateTransaction(transaction(), { transactionSignature: "sig", payer, treasury, reference, mint: address() })).toThrow(/official USDC/));
  it("rejects a transaction missing the unique order reference", () => {
    const value = transaction();
    value.transaction.message.accountKeys = value.transaction.message.accountKeys.filter((key) => key.pubkey !== reference);
    expect(() => verifier.validateTransaction(value, { transactionSignature: "sig", payer, treasury, reference })).toThrow(/reference is missing/);
  });

  it("keeps devnet test-mint validation behind both an opt-in and the canonical devnet genesis", () => {
    const mint = address();
    const input = { transactionSignature: "sig", payer, treasury, reference, mint, amountBaseUnits: USDC_AMOUNT_BASE_UNITS };
    delete process.env.REVIVE_DEVNET_PAYMENT_E2E;
    expect(() => validateDevnetPaymentTransactionForE2E(transaction(USDC_AMOUNT_BASE_UNITS, mint), input, SOLANA_DEVNET_GENESIS_HASH)).toThrow(/disabled/);
    process.env.REVIVE_DEVNET_PAYMENT_E2E = "1";
    expect(() => validateDevnetPaymentTransactionForE2E(transaction(USDC_AMOUNT_BASE_UNITS, mint), input, "mainnet-genesis")).toThrow(/non-devnet/);
    expect(() => validateDevnetPaymentTransactionForE2E(transaction(USDC_AMOUNT_BASE_UNITS, mint), input, SOLANA_DEVNET_GENESIS_HASH)).not.toThrow();
    delete process.env.REVIVE_DEVNET_PAYMENT_E2E;
  });
});
