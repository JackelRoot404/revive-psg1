import { describe, expect, it } from "vitest";
import { AccountRole, address } from "@solana/kit";
import {
  TOKEN_PROGRAM_ADDRESS,
  parseCreateAssociatedTokenIdempotentInstruction,
  parseTransferCheckedInstruction
} from "@solana-program/token";
import { parseAddMemoInstruction } from "@solana-program/memo";
import {
  SOLANA_USDC_MINT,
  TREASURY_WALLET,
  USDC_AMOUNT_BASE_UNITS,
  USDC_DECIMALS
} from "@revive-psg1/contracts";
import { buildPaymentInstructions } from "./payment-transaction";

const PAYER = "So11111111111111111111111111111111111111112";
const REFERENCE = "Vote111111111111111111111111111111111111111";
const ORDER_ID = "order_checkout_123";

describe("buildPaymentInstructions", () => {
  it("creates the treasury ATA idempotently, transfers exactly 29 USDC, and embeds the order reference", async () => {
    const result = await buildPaymentInstructions({ payer: PAYER, reference: REFERENCE, orderId: ORDER_ID });
    expect(result.instructions).toHaveLength(3);

    const createAta = parseCreateAssociatedTokenIdempotentInstruction(result.instructions[0] as never);
    expect(createAta.accounts.payer.address).toBe(PAYER);
    expect(createAta.accounts.payer.role).toBe(AccountRole.WRITABLE_SIGNER);
    expect(createAta.accounts.ata.address).toBe(result.destinationAta);
    expect(createAta.accounts.owner.address).toBe(TREASURY_WALLET);
    expect(createAta.accounts.mint.address).toBe(SOLANA_USDC_MINT);
    expect(createAta.accounts.tokenProgram.address).toBe(TOKEN_PROGRAM_ADDRESS);

    const transfer = parseTransferCheckedInstruction(result.instructions[1] as never);
    expect(transfer.accounts.source.address).toBe(result.sourceAta);
    expect(transfer.accounts.mint.address).toBe(SOLANA_USDC_MINT);
    expect(transfer.accounts.destination.address).toBe(result.destinationAta);
    expect(transfer.accounts.authority.address).toBe(PAYER);
    expect(transfer.accounts.authority.role).toBe(AccountRole.READONLY_SIGNER);
    expect(transfer.data.amount).toBe(USDC_AMOUNT_BASE_UNITS);
    expect(transfer.data.decimals).toBe(USDC_DECIMALS);
    expect(result.instructions[1]?.accounts?.at(-1)).toEqual({ address: address(REFERENCE), role: AccountRole.READONLY });

    const memoInstruction = result.instructions[2]!;
    const memo = parseAddMemoInstruction(memoInstruction as never);
    expect(memo.data.memo).toBe(`Revive PSG1 order ${ORDER_ID}`);
    expect(memoInstruction.accounts).toEqual([]);
  });

  it("fails closed before constructing instructions for malformed wallet or reference addresses", async () => {
    await expect(buildPaymentInstructions({ payer: "not-a-wallet", reference: REFERENCE, orderId: ORDER_ID })).rejects.toThrow();
    await expect(buildPaymentInstructions({ payer: PAYER, reference: "not-a-reference", orderId: ORDER_ID })).rejects.toThrow();
  });
});
