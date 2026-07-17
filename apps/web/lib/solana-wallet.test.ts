import { describe, expect, it, vi } from "vitest";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import { StandardConnect, StandardEvents } from "@wallet-standard/features";
import { SolanaSignAndSendTransaction, SolanaSignMessage } from "@solana/wallet-standard-features";
import {
  SOLANA_MAINNET_CHAIN,
  isReviveWallet,
  signAndSendMainnetTransaction,
  signExactMessage,
  type ReviveWallet
} from "./solana-wallet";

const account: WalletAccount = {
  address: "So11111111111111111111111111111111111111112",
  publicKey: new Uint8Array(32),
  chains: [SOLANA_MAINNET_CHAIN],
  features: [SolanaSignMessage, SolanaSignAndSendTransaction]
};

function walletFixture() {
  const signMessage = vi.fn(async (...inputs: Array<{ account: WalletAccount; message: Uint8Array }>) =>
    inputs.map((input) => ({ account: input.account, signedMessage: input.message, signature: new Uint8Array(64) }))
  );
  const signAndSendTransaction = vi.fn(async (...inputs: Array<{ account: WalletAccount }>) =>
    inputs.map(() => ({ signature: new Uint8Array(64) }))
  );
  const wallet = {
    version: "1.0.0",
    name: "Test injected wallet",
    icon: "data:image/svg+xml;base64,PHN2Zy8+",
    chains: [SOLANA_MAINNET_CHAIN],
    accounts: [account],
    features: {
      [StandardConnect]: { version: "1.0.0", connect: vi.fn(async () => ({ accounts: [account] })) },
      [StandardEvents]: { version: "1.0.0", on: vi.fn(() => () => undefined) },
      [SolanaSignMessage]: { version: "1.0.0", signMessage },
      [SolanaSignAndSendTransaction]: {
        version: "1.0.0",
        supportedTransactionVersions: ["legacy"],
        signAndSendTransaction
      }
    }
  } as unknown as ReviveWallet;
  return { wallet, signMessage, signAndSendTransaction };
}

describe("Wallet Standard checkout boundary", () => {
  it("accepts only a mainnet wallet with message signing and legacy transaction support", () => {
    const { wallet } = walletFixture();
    expect(isReviveWallet(wallet)).toBe(true);

    const missingLegacy = {
      ...wallet,
      features: {
        ...wallet.features,
        [SolanaSignAndSendTransaction]: {
          ...wallet.features[SolanaSignAndSendTransaction],
          supportedTransactionVersions: [0]
        }
      }
    } as unknown as Wallet;
    expect(isReviveWallet(missingLegacy)).toBe(false);
    expect(isReviveWallet({ ...wallet, chains: ["solana:devnet"] } as unknown as Wallet)).toBe(false);
  });

  it("rejects a wallet that alters the signed authorization message", async () => {
    const { wallet, signMessage } = walletFixture();
    signMessage.mockResolvedValueOnce([{
      account,
      signedMessage: new TextEncoder().encode("modified"),
      signature: new Uint8Array(64)
    }]);
    await expect(signExactMessage(wallet, account, new TextEncoder().encode("exact challenge"))).rejects.toThrow(/modified/i);
  });

  it("forces mainnet, confirmed preflight, and a bounded retry count when sending", async () => {
    const { wallet, signAndSendTransaction } = walletFixture();
    const transaction = new Uint8Array([1, 2, 3]);
    await expect(signAndSendMainnetTransaction(wallet, account, transaction)).resolves.toHaveLength(64);
    expect(signAndSendTransaction).toHaveBeenCalledWith({
      account,
      chain: SOLANA_MAINNET_CHAIN,
      transaction,
      options: {
        preflightCommitment: "confirmed",
        commitment: "confirmed",
        skipPreflight: false,
        maxRetries: 3
      }
    });
  });
});
