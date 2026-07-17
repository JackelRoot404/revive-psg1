import { getWallets } from "@wallet-standard/app";
import type { Wallet, WalletAccount, WalletWithFeatures } from "@wallet-standard/base";
import {
  StandardConnect,
  StandardEvents,
  type StandardConnectFeature,
  type StandardEventsFeature
} from "@wallet-standard/features";
import {
  SolanaSignAndSendTransaction,
  SolanaSignMessage,
  type SolanaSignAndSendTransactionFeature,
  type SolanaSignMessageFeature
} from "@solana/wallet-standard-features";

export const SOLANA_MAINNET_CHAIN = "solana:mainnet";

type RequiredFeatures = StandardConnectFeature
  & StandardEventsFeature
  & SolanaSignMessageFeature
  & SolanaSignAndSendTransactionFeature;

export type ReviveWallet = WalletWithFeatures<RequiredFeatures>;

export function isReviveWallet(wallet: Wallet): wallet is ReviveWallet {
  const features = wallet.features;
  const send = features[SolanaSignAndSendTransaction] as
    | SolanaSignAndSendTransactionFeature[typeof SolanaSignAndSendTransaction]
    | undefined;
  return wallet.chains.includes(SOLANA_MAINNET_CHAIN)
    && StandardConnect in features
    && StandardEvents in features
    && SolanaSignMessage in features
    && Boolean(send?.supportedTransactionVersions.includes("legacy"));
}

export function compatibleWallets(): ReviveWallet[] {
  return getWallets().get().filter(isReviveWallet);
}

export function watchCompatibleWallets(listener: (wallets: ReviveWallet[]) => void): () => void {
  const registry = getWallets();
  const refresh = () => listener(compatibleWallets());
  const offRegister = registry.on("register", refresh);
  const offUnregister = registry.on("unregister", refresh);
  refresh();
  return () => { offRegister(); offUnregister(); };
}

export function isUsableMainnetAccount(account: WalletAccount): boolean {
  return account.chains.includes(SOLANA_MAINNET_CHAIN)
    && account.features.includes(SolanaSignMessage)
    && account.features.includes(SolanaSignAndSendTransaction);
}

export async function connectWallet(wallet: ReviveWallet): Promise<WalletAccount> {
  const { accounts } = await wallet.features[StandardConnect].connect();
  const account = accounts.find(isUsableMainnetAccount);
  if (!account) throw new Error("This wallet did not authorize a Solana mainnet account with message and transaction signing.");
  return account;
}

export function watchWalletAccounts(wallet: ReviveWallet, listener: (accounts: readonly WalletAccount[]) => void): () => void {
  return wallet.features[StandardEvents].on("change", ({ accounts }) => {
    if (accounts) listener(accounts);
  });
}

export async function signExactMessage(wallet: ReviveWallet, account: WalletAccount, message: Uint8Array): Promise<Uint8Array> {
  const [output] = await wallet.features[SolanaSignMessage].signMessage({ account, message });
  if (!output || !equalBytes(output.signedMessage, message)) {
    throw new Error("The wallet modified the checkout authorization message, so it cannot be verified safely.");
  }
  if (output.signature.length !== 64) throw new Error("The wallet returned an invalid Ed25519 signature.");
  return output.signature;
}

export async function signAndSendMainnetTransaction(
  wallet: ReviveWallet,
  account: WalletAccount,
  transaction: Uint8Array
): Promise<Uint8Array> {
  const [output] = await wallet.features[SolanaSignAndSendTransaction].signAndSendTransaction({
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
  if (!output || output.signature.length !== 64) throw new Error("The wallet did not return a valid Solana transaction signature.");
  return output.signature;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}
