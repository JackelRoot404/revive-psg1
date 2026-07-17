import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getTransactionEncoder,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Blockhash,
  type BlockhashLifetimeConstraint,
  type Instruction
} from "@solana/kit";
import {
  TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction
} from "@solana-program/token";
import { getAddMemoInstruction } from "@solana-program/memo";
import { SOLANA_USDC_MINT, TREASURY_WALLET, USDC_AMOUNT_BASE_UNITS, USDC_DECIMALS } from "@revive-psg1/contracts";

export type PaymentInstructionSet = {
  sourceAta: string;
  destinationAta: string;
  instructions: readonly Instruction[];
};

export async function buildPaymentInstructions(input: {
  payer: string;
  reference: string;
  orderId: string;
}): Promise<PaymentInstructionSet> {
  const payer = address(input.payer);
  const payerSigner = createNoopSigner(payer);
  const treasury = address(TREASURY_WALLET);
  const mint = address(SOLANA_USDC_MINT);
  const reference = address(input.reference);
  const [sourceAta] = await findAssociatedTokenPda({ owner: payer, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const [destinationAta] = await findAssociatedTokenPda({ owner: treasury, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });

  const createDestinationAta = getCreateAssociatedTokenIdempotentInstruction({
    payer: payerSigner,
    ata: destinationAta,
    owner: treasury,
    mint,
    tokenProgram: TOKEN_PROGRAM_ADDRESS
  });
  const transferBase = getTransferCheckedInstruction({
    source: sourceAta,
    mint,
    destination: destinationAta,
    authority: payerSigner,
    amount: USDC_AMOUNT_BASE_UNITS,
    decimals: USDC_DECIMALS
  });
  const transfer: Instruction = {
    ...transferBase,
    // Solana Pay references are extra readonly accounts on the transfer. Do not
    // attach a non-signer to Memo: the Memo program requires every account it
    // receives to sign and would reject the payment during preflight.
    accounts: [...(transferBase.accounts ?? []), { address: reference, role: AccountRole.READONLY }]
  };
  const memo = getAddMemoInstruction({ memo: `Revive PSG1 order ${input.orderId}` });
  return {
    sourceAta,
    destinationAta,
    instructions: [createDestinationAta, transfer, memo]
  };
}

export async function buildPaymentTransaction(input: {
  payer: string;
  reference: string;
  orderId: string;
  blockhash: Blockhash;
  lastValidBlockHeight: bigint;
}): Promise<Uint8Array> {
  const { instructions } = await buildPaymentInstructions(input);
  const message = setTransactionMessageLifetimeUsingBlockhash(
    { blockhash: input.blockhash, lastValidBlockHeight: input.lastValidBlockHeight } satisfies BlockhashLifetimeConstraint,
    setTransactionMessageFeePayer(
      address(input.payer),
      appendTransactionMessageInstructions(instructions, createTransactionMessage({ version: "legacy" }))
    )
  );
  return Uint8Array.from(getTransactionEncoder().encode(compileTransaction(message)));
}
