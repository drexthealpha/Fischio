// An embedded wallet: a keypair generated in the browser and kept in localStorage, so a
// visitor with no wallet extension and no SOL can still trade. Paired with the gasless
// relayer (relay.js), it gives a real zero-to-trade path, land on the site, get a wallet,
// place a live on-chain order, without ever installing anything or funding gas.
//
// This is demo-grade key storage: localStorage is not a secure enclave, so the production
// version of this is a managed embedded wallet (Privy, which supports Solana, or Turnkey for
// hardware-isolated keys) that adds social login and cross-device recovery. Swapping this
// file for a Privy-backed signer is the only change; every consumer just needs the
// AnchorWallet shape below (publicKey, signTransaction, signAllTransactions).
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";

const KEY = "fischio.guest.secret";

function load() {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(stored)));
  } catch { /* corrupt or absent: fall through and mint a fresh one */ }
  const kp = Keypair.generate();
  localStorage.setItem(KEY, JSON.stringify([...kp.secretKey]));
  return kp;
}

let cached = null;
export function guestKeypair() {
  if (!cached) cached = load();
  return cached;
}

export function hasGuestWallet() {
  try { return !!localStorage.getItem(KEY); } catch { return false; }
}

export function forgetGuestWallet() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
  cached = null;
}

// An AnchorWallet-shaped signer backed by the embedded keypair. Drop-in wherever the app
// uses the wallet-adapter's useAnchorWallet(), so read paths and tx building are identical.
export function guestAnchorWallet() {
  const kp = guestKeypair();
  return {
    publicKey: kp.publicKey,
    signTransaction: async (tx) => { tx.partialSign(kp); return tx; },
    signAllTransactions: async (txs) => { for (const tx of txs) tx.partialSign(kp); return txs; },
    // sign an arbitrary message (Sign-In With Solana), same shape as a wallet adapter's
    signMessage: async (message) => nacl.sign.detached(message, kp.secretKey),
    _keypair: kp, // used by relay.js to sign the user's half before handing gas to the relayer
    _fischioEmbedded: true, // marks this as the gasless embedded wallet, so execute() routes it
  };
}
