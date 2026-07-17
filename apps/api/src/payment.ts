import bs58 from "bs58";
import { LICENSE_PRICE_USDC, SOLANA_USDC_MINT, USDC_AMOUNT_BASE_UNITS } from "@revive-psg1/contracts";
import type { Config } from "./config";

export type PaymentExpectation = {
  transactionSignature: string;
  payer: string;
  treasury: string;
  reference: string;
  mint?: string;
  amountBaseUnits?: bigint;
};

export type VerifiedPayment = {
  signature: string;
  slot: number;
  blockTime: number | null;
};

type TokenBalance = {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals: number };
};

export type ParsedPaymentTransaction = {
  slot: number;
  blockTime: number | null;
  transaction: {
    message: {
      accountKeys: Array<{ pubkey: string; signer: boolean; writable: boolean }>;
    };
  };
  meta: {
    err: unknown;
    preTokenBalances?: TokenBalance[] | null;
    postTokenBalances?: TokenBalance[] | null;
  } | null;
};

export const SOLANA_DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

export class PaymentVerificationError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
  }
}

export class SolanaPaymentVerifier {
  private readonly rpcUrls: string[];

  constructor(config: Config) {
    this.rpcUrls = [config.solanaRpcPrimary, config.solanaRpcFallback].filter((url): url is string => Boolean(url));
  }

  async verify(input: PaymentExpectation): Promise<VerifiedPayment> {
    let lastError: unknown;
    for (const rpcUrl of this.rpcUrls) {
      try {
        return await this.verifyWithRpc(rpcUrl, input);
      } catch (error) {
        lastError = error;
        if (error instanceof PaymentVerificationError && !["RPC_UNAVAILABLE", "NOT_FINALIZED", "TRANSACTION_MISSING"].includes(error.code)) throw error;
      }
    }
    throw new PaymentVerificationError(
      lastError instanceof Error ? `Solana RPC unavailable: ${lastError.message}` : "Solana RPC unavailable",
      "RPC_UNAVAILABLE"
    );
  }

  private async verifyWithRpc(rpcUrl: string, input: PaymentExpectation): Promise<VerifiedPayment> {
    const status = await rpcRequest<{ value: Array<{ confirmationStatus: string | null; err: unknown } | null> }>(
      rpcUrl,
      "getSignatureStatuses",
      [[input.transactionSignature], { searchTransactionHistory: true }]
    );
    const signatureStatus = status.value[0];
    if (!signatureStatus || signatureStatus.confirmationStatus !== "finalized" || signatureStatus.err) {
      throw new PaymentVerificationError("Transaction is not finalized and successful", "NOT_FINALIZED");
    }
    const transaction = await rpcRequest<ParsedPaymentTransaction | null>(rpcUrl, "getTransaction", [
      input.transactionSignature,
      { commitment: "finalized", maxSupportedTransactionVersion: 0, encoding: "jsonParsed" }
    ]);
    if (!transaction?.meta || transaction.meta.err) {
      throw new PaymentVerificationError("Finalized transaction could not be loaded", "TRANSACTION_MISSING");
    }
    this.validateTransaction(transaction, input);
    return { signature: input.transactionSignature, slot: transaction.slot, blockTime: transaction.blockTime ?? null };
  }

  validateTransaction(transaction: ParsedPaymentTransaction, input: PaymentExpectation): void {
    if (input.amountBaseUnits !== undefined && input.amountBaseUnits !== USDC_AMOUNT_BASE_UNITS) {
      throw new PaymentVerificationError(`Order amount does not match the fixed ${Number(LICENSE_PRICE_USDC)} USDC price`, "WRONG_AMOUNT_EXPECTATION");
    }
    validatePaymentTransaction(transaction, input, {
      mint: SOLANA_USDC_MINT,
      amountBaseUnits: USDC_AMOUNT_BASE_UNITS,
      mintError: "Order mint is not official USDC"
    });
  }
}

/**
 * Exercises the production payment invariants with an ephemeral token on Solana
 * devnet. This helper is deliberately unavailable unless the caller opts into
 * the standalone E2E process and proves the RPC is the canonical devnet.
 * Production request handling never calls this function.
 */
export function validateDevnetPaymentTransactionForE2E(
  transaction: ParsedPaymentTransaction,
  input: PaymentExpectation & { mint: string; amountBaseUnits: bigint },
  genesisHash: string
): void {
  if (process.env.REVIVE_DEVNET_PAYMENT_E2E !== "1") {
    throw new PaymentVerificationError("Devnet payment validation is disabled", "DEVNET_E2E_DISABLED");
  }
  if (genesisHash !== SOLANA_DEVNET_GENESIS_HASH) {
    throw new PaymentVerificationError("Devnet E2E refused a non-devnet cluster", "WRONG_CLUSTER");
  }
  if (input.mint === SOLANA_USDC_MINT) {
    throw new PaymentVerificationError("Devnet E2E requires an ephemeral test mint", "DEVNET_MINT_REQUIRED");
  }
  validatePaymentTransaction(transaction, input, {
    mint: input.mint,
    amountBaseUnits: input.amountBaseUnits,
    mintError: "Transaction mint does not match the ephemeral devnet mint"
  });
}

function validatePaymentTransaction(
  transaction: ParsedPaymentTransaction,
  input: PaymentExpectation,
  policy: { mint: string; amountBaseUnits: bigint; mintError: string }
): void {
    assertSolanaAddress(input.treasury);
    assertSolanaAddress(input.payer);
    assertSolanaAddress(input.reference);
    const keys = transaction.transaction.message.accountKeys;
    const payer = keys.find((entry) => entry.pubkey === input.payer);
    if (!payer?.signer) throw new PaymentVerificationError("Connected wallet did not sign the transaction", "PAYER_NOT_SIGNER");
    if (!keys.some((entry) => entry.pubkey === input.reference)) {
      throw new PaymentVerificationError("Order reference is missing", "REFERENCE_MISSING");
    }
    const expected = input.amountBaseUnits ?? policy.amountBaseUnits;
    const mint = input.mint ?? policy.mint;
    if (mint !== policy.mint) throw new PaymentVerificationError(policy.mintError, "WRONG_MINT");
    const treasuryDelta = tokenDelta(transaction, input.treasury, mint);
    const payerDelta = tokenDelta(transaction, input.payer, mint);
    if (treasuryDelta !== expected) throw new PaymentVerificationError("Treasury did not receive the exact USDC amount", "WRONG_AMOUNT");
    if (payerDelta !== -expected) throw new PaymentVerificationError("Payer USDC debit does not match the order", "WRONG_PAYER");
}

async function rpcRequest<T>(rpcUrl: string, method: string, params: unknown[]): Promise<T> {
  let response: Response;
  try {
    response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(10_000)
    });
  } catch (error) {
    throw new PaymentVerificationError(error instanceof Error ? error.message : "RPC request failed", "RPC_UNAVAILABLE");
  }
  if (!response.ok) throw new PaymentVerificationError(`RPC returned HTTP ${response.status}`, "RPC_UNAVAILABLE");
  const payload = await response.json() as { result?: T; error?: { message?: string } };
  if (payload.error || !("result" in payload)) {
    throw new PaymentVerificationError(payload.error?.message ?? "RPC returned an invalid response", "RPC_UNAVAILABLE");
  }
  return payload.result as T;
}

function assertSolanaAddress(value: string): void {
  try {
    if (bs58.decode(value).length !== 32) throw new Error("wrong length");
  } catch {
    throw new PaymentVerificationError("Malformed Solana address", "MALFORMED_ADDRESS");
  }
}

function tokenDelta(transaction: ParsedPaymentTransaction, owner: string, mint: string): bigint {
  const balances = new Map<number, bigint>();
  for (const balance of transaction.meta?.preTokenBalances ?? []) {
    if (balance.owner === owner && balance.mint === mint) balances.set(balance.accountIndex, -BigInt(balance.uiTokenAmount.amount));
  }
  for (const balance of transaction.meta?.postTokenBalances ?? []) {
    if (balance.owner === owner && balance.mint === mint) {
      balances.set(balance.accountIndex, (balances.get(balance.accountIndex) ?? 0n) + BigInt(balance.uiTokenAmount.amount));
    }
  }
  return [...balances.values()].reduce((total, value) => total + value, 0n);
}
