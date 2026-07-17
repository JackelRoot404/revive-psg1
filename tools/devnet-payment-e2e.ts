import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  devnet,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Instruction
} from "@solana/kit";
import {
  TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction
} from "@solana-program/token";
import { getAddMemoInstruction } from "@solana-program/memo";
import { TREASURY_WALLET, USDC_AMOUNT_BASE_UNITS, USDC_DECIMALS } from "@revive-psg1/contracts";
import {
  SOLANA_DEVNET_GENESIS_HASH,
  SolanaPaymentVerifier,
  validateDevnetPaymentTransactionForE2E,
  type ParsedPaymentTransaction,
  type PaymentVerificationError
} from "../apps/api/src/payment";
import type { Config } from "../apps/api/src/config";

const runFile = promisify(execFile);
const rpcUrl = process.env.SOLANA_DEVNET_RPC ?? "https://api.devnet.solana.com";
const fundingKeypair = process.env.DEVNET_FUNDING_KEYPAIR;
const amountTokens = "29";

process.env.REVIVE_DEVNET_PAYMENT_E2E = "1";

void main();

async function main(): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), "revive-payment-devnet-"));
  const payerPath = join(workspace, "ephemeral-payer.json");
  try {
  const rpc = createSolanaRpc(devnet(rpcUrl));
  const genesisHash = await rpc.getGenesisHash().send();
  if (genesisHash !== SOLANA_DEVNET_GENESIS_HASH) {
    throw new Error(`Refusing non-devnet RPC: unexpected genesis ${genesisHash}`);
  }

  await command("solana-keygen", ["new", "--no-bip39-passphrase", "--silent", "--force", "-o", payerPath]);
  const payer = (await command("solana-keygen", ["pubkey", payerPath])).trim();
  const reference = await generateKeyPairSigner();

  let fundedBy = "devnet faucet";
  try {
    await command("solana", ["airdrop", "0.25", payer, "--url", rpcUrl]);
  } catch (faucetError) {
    if (!fundingKeypair) {
      throw new Error(
        `Devnet faucet was unavailable. Set DEVNET_FUNDING_KEYPAIR to an already-funded devnet-only keypair and retry. ${message(faucetError)}`
      );
    }
    await command("solana", [
      "transfer", payer, "0.25", "--allow-unfunded-recipient", "--keypair", fundingKeypair, "--url", rpcUrl
    ]);
    fundedBy = "explicit devnet funding keypair";
  }

  const createMintOutput = await command("spl-token", [
    "create-token", "--decimals", String(USDC_DECIMALS), "--fee-payer", payerPath,
    "--mint-authority", payerPath, "--url", rpcUrl
  ]);
  const mint = matchAddress(createMintOutput, /Creating token ([1-9A-HJ-NP-Za-km-z]{32,44})/u, "mint");
  const createSourceOutput = await command("spl-token", [
    "create-account", mint, "--owner", payer, "--fee-payer", payerPath, "--url", rpcUrl
  ]);
  const sourceTokenAccount = matchAddress(createSourceOutput, /Creating account ([1-9A-HJ-NP-Za-km-z]{32,44})/u, "source token account");
  await command("spl-token", [
    "mint", mint, amountTokens, sourceTokenAccount, "--mint-authority", payerPath,
    "--fee-payer", payerPath, "--url", rpcUrl
  ]);

  const payerBytes = new Uint8Array(JSON.parse(await readFile(payerPath, "utf8")) as number[]);
  const payerSigner = await createKeyPairSignerFromBytes(payerBytes);
  if (payerSigner.address !== payer) throw new Error("Ephemeral payer key did not round-trip");
  const mintAddress = address(mint);
  const treasury = address(TREASURY_WALLET);
  const [destinationTokenAccount] = await findAssociatedTokenPda({
    owner: treasury,
    mint: mintAddress,
    tokenProgram: TOKEN_PROGRAM_ADDRESS
  });
  const createDestination = getCreateAssociatedTokenIdempotentInstruction({
    payer: payerSigner,
    ata: destinationTokenAccount,
    owner: treasury,
    mint: mintAddress,
    tokenProgram: TOKEN_PROGRAM_ADDRESS
  });
  const transferBase = getTransferCheckedInstruction({
    source: address(sourceTokenAccount),
    mint: mintAddress,
    destination: destinationTokenAccount,
    authority: payerSigner,
    amount: USDC_AMOUNT_BASE_UNITS,
    decimals: USDC_DECIMALS
  });
  const transfer: Instruction = {
    ...transferBase,
    accounts: [...(transferBase.accounts ?? []), { address: reference.address, role: AccountRole.READONLY }]
  };
  const memo = getAddMemoInstruction({ memo: `Revive PSG1 devnet E2E ${Date.now()}` });
  const latest = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const transactionMessage = setTransactionMessageLifetimeUsingBlockhash(
    latest.value,
    setTransactionMessageFeePayerSigner(
      payerSigner,
      appendTransactionMessageInstructions([createDestination, transfer, memo], createTransactionMessage({ version: "legacy" }))
    )
  );
  const signedTransaction = await signTransactionMessageWithSigners(transactionMessage);
  const transactionSignature = await rpc.sendTransaction(getBase64EncodedWireTransaction(signedTransaction), {
    encoding: "base64",
    preflightCommitment: "confirmed",
    skipPreflight: false
  }).send();
  await waitForFinalized(rpcUrl, transactionSignature);
  const transaction = await rpcRequest<ParsedPaymentTransaction | null>("getTransaction", [
    transactionSignature,
    { commitment: "finalized", maxSupportedTransactionVersion: 0, encoding: "jsonParsed" }
  ]);
  if (!transaction?.meta || transaction.meta.err) throw new Error("Finalized devnet transaction was unavailable or failed");

  const expectation = {
    transactionSignature,
    payer,
    treasury: TREASURY_WALLET,
    reference: reference.address,
    mint,
    amountBaseUnits: USDC_AMOUNT_BASE_UNITS
  };
  validateDevnetPaymentTransactionForE2E(transaction, expectation, genesisHash);

  const productionVerifier = new SolanaPaymentVerifier({ solanaRpcPrimary: rpcUrl } as Config);
  let productionRejectedTestMint = false;
  try {
    await productionVerifier.verify(expectation);
  } catch (error) {
    productionRejectedTestMint = (error as PaymentVerificationError).code === "WRONG_MINT";
  }
  if (!productionRejectedTestMint) throw new Error("Production verifier did not reject the ephemeral devnet mint");

  console.log(JSON.stringify({
    status: "passed",
    cluster: "devnet",
    genesisHash,
    fundedBy,
    payer,
    treasury: TREASURY_WALLET,
    mint,
    reference: reference.address,
    amountBaseUnits: USDC_AMOUNT_BASE_UNITS.toString(),
    transactionSignature,
    explorerUrl: `https://explorer.solana.com/tx/${transactionSignature}?cluster=devnet`,
    productionVerifierRejectedTestMint: productionRejectedTestMint
  }, null, 2));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function command(executable: string, args: string[]): Promise<string> {
  const result = await runFile(executable, args, { timeout: 60_000, maxBuffer: 2_000_000 });
  return `${result.stdout}${result.stderr}`;
}

function matchAddress(output: string, pattern: RegExp, label: string): string {
  const value = output.match(pattern)?.[1];
  if (!value) throw new Error(`Could not parse ${label} from command output`);
  return value;
}

async function waitForFinalized(url: string, signature: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getSignatureStatuses",
        params: [[signature], { searchTransactionHistory: true }]
      })
    });
    const payload = await response.json() as {
      result?: { value: Array<{ confirmationStatus: string | null; err: unknown } | null> };
      error?: { message?: string };
    };
    if (!response.ok || payload.error || !payload.result) throw new Error(payload.error?.message ?? `RPC HTTP ${response.status}`);
    const result = payload.result;
    const status = result.value[0];
    if (status?.err) throw new Error(`Devnet transaction failed: ${JSON.stringify(status.err)}`);
    if (status?.confirmationStatus === "finalized") return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("Timed out waiting for finalized devnet transaction");
}

async function rpcRequest<T>(method: string, params: unknown[]): Promise<T> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  const payload = await response.json() as { result?: T; error?: { message?: string } };
  if (!response.ok || payload.error || !("result" in payload)) throw new Error(payload.error?.message ?? `RPC HTTP ${response.status}`);
  return payload.result as T;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
