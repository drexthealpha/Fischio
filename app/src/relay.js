// Gasless + sponsored execution for the embedded wallet. An external wallet (Phantom, etc.)
// pays its own fees as usual; the embedded wallet (guestWallet.js) routes through the relayer
// so it needs no SOL, and its account rent is covered once by the sponsor.
//
// The seam is one function, execute(), that the trade helpers call instead of .rpc(). It
// keeps every trade path identical for real wallets and only diverges for the embedded one,
// so there is no second code path to drift. Upgrading to Kora (fees) or Privy (the wallet)
// later changes only this file.
import { connection } from "./chain.js";

const params = new URLSearchParams(window.location.search);
const RELAYER = params.get("relayer") ?? "http://127.0.0.1:8791";
const SPONSOR = params.get("sponsor") ?? "http://127.0.0.1:8793";

let feePayerCache = null;
async function feePayer() {
  if (!feePayerCache) feePayerCache = (await (await fetch(`${RELAYER}/feepayer`)).json()).feePayer;
  return feePayerCache;
}

// Build the transaction from an Anchor methods builder, set the relayer as fee payer, have
// the embedded wallet sign its half, then hand it to the relayer to co-sign and submit.
export async function sendGasless(methodBuilder, wallet) {
  const { PublicKey } = await import("@solana/web3.js");
  const tx = await methodBuilder.transaction();
  tx.feePayer = new PublicKey(await feePayer());
  tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  const signed = await wallet.signTransaction(tx); // user authorizes only their own instructions
  const b64 = signed.serialize({ requireAllSignatures: false }).toString("base64");
  const j = await (await fetch(`${RELAYER}/relay`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tx: b64 }),
  })).json();
  if (!j.signature) throw new Error(j.error ?? "relay failed");
  await connection.confirmTransaction(j.signature, "confirmed");
  return j.signature;
}

// The one seam the trade helpers call. Embedded wallet -> gasless relay; real wallet -> normal
// send. Detected by a marker the embedded wallet sets, so nothing else needs to know.
export async function execute(methodBuilder, wallet) {
  if (wallet?._fischioEmbedded) return sendGasless(methodBuilder, wallet);
  return methodBuilder.rpc();
}

// Ready an embedded wallet to trade a market: the sponsor creates its token accounts (paying
// the rent) and faucets test USDC. Idempotent, so calling it before every trade is cheap.
export async function prepareEmbedded(owner, mints = [], faucetUsdc = 1000) {
  const j = await (await fetch(`${SPONSOR}/prepare`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ owner: owner.toBase58?.() ?? owner, mints: mints.map((m) => m.toBase58?.() ?? m), faucetUsdc }),
  })).json();
  if (!j.ok) throw new Error(j.error ?? "prepare failed");
  return j;
}

// Onboard an embedded wallet to an exchange book: the sponsor pays the OpenOrders rent while
// the wallet signs as owner. `buildInitIx` returns the init_open_orders instruction.
export async function sponsorOnboard(tx, wallet) {
  const { PublicKey } = await import("@solana/web3.js");
  tx.feePayer = new PublicKey((await (await fetch(`${SPONSOR}/sponsor`)).json()).sponsor);
  tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  const signed = await wallet.signTransaction(tx);
  const b64 = signed.serialize({ requireAllSignatures: false }).toString("base64");
  const j = await (await fetch(`${SPONSOR}/onboard`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tx: b64 }),
  })).json();
  if (!j.signature) throw new Error(j.error ?? "onboard failed");
  await connection.confirmTransaction(j.signature, "confirmed");
  return j.signature;
}

// On-ramp: buy trading USDC with SOL. The user sends SOL to the sponsor, then the sponsor
// mints the matching USDC to them. For a wallet that holds SOL (an external wallet); an
// embedded wallet with no SOL uses prepareEmbedded's faucet instead.
export async function buyUsdcWithSol(wallet, solAmount) {
  const { SystemProgram, Transaction, PublicKey } = await import("@solana/web3.js");
  const sponsorPk = new PublicKey((await (await fetch(`${SPONSOR}/sponsor`)).json()).sponsor);
  const tx = new Transaction().add(SystemProgram.transfer({
    fromPubkey: wallet.publicKey, toPubkey: sponsorPk, lamports: Math.round(solAmount * 1e9),
  }));
  tx.feePayer = wallet.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  const signed = await wallet.signTransaction(tx);
  const sig = await connection.sendRawTransaction(signed.serialize());
  await connection.confirmTransaction(sig, "confirmed");
  const j = await (await fetch(`${SPONSOR}/buy`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ signature: sig }),
  })).json();
  if (!j.ok) throw new Error(j.error ?? "buy failed");
  return j;
}

// Are the gasless services up? The UI uses this to decide whether to offer instant-wallet mode.
export async function servicesAvailable() {
  try {
    const [r, s] = await Promise.all([fetch(`${RELAYER}/health`), fetch(`${SPONSOR}/health`)]);
    return r.ok && s.ok;
  } catch { return false; }
}
