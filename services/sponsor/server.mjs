// fischio onboarding sponsor. This is the piece that lets a wallet with zero SOL actually
// start trading, the equivalent of the proxy wallet Polymarket's relayer deploys and funds
// on a user's first action. The gasless relayer covers transaction fees but deliberately
// refuses to be an instruction signer, so it cannot pay account rent. This service can,
// safely, because it validates that every instruction it co-signs is a bounded onboarding
// step whose new account is owned by the user, never by the sponsor:
//
//   - exchange init_open_orders, where the sponsor is only the rent `payer` and the `owner`
//     (the trading authority) is a different signing key, the user's embedded wallet
//   - associated-token-account creation, where the sponsor is only the `payer`
//   - compute-budget instructions
//
// Anything else is rejected. The sponsor spends only rent it can predict, on accounts the
// user controls, so a malicious caller cannot turn it into a general-purpose faucet.
//
//   POST /onboard  { tx: base64 }  user-signed onboarding tx; sponsor co-signs and submits
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import express from "express";
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, Transaction, PublicKey } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";

const FUSDC = process.env.FUSDC ?? "rRsB6zN2rht5b2CdEFArhosMdaKVLyX7uePLfuAYHc9"; // shared devnet test-USDC

const here = dirname(fileURLToPath(import.meta.url));
const RPC = process.env.RPC ?? "https://api.devnet.solana.com";
const PORT = Number(process.env.PORT ?? 8793);
const KEY_PATH = process.env.SPONSOR_KEY ?? join(here, "..", "..", "local", "devnet-wallet.json");
const connection = new Connection(RPC, "confirmed");
const sponsor = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(KEY_PATH, "utf8"))));

const exchangeIdl = JSON.parse(readFileSync(join(here, "..", "api", "idl", "fischio_exchange.json"), "utf8"));
const EXCHANGE_PID = exchangeIdl.address; // base58 string, compared against ix.programId.toBase58()
const coder = new anchor.BorshInstructionCoder(exchangeIdl);
const ATA_PID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const COMPUTE_PID = "ComputeBudget111111111111111111111111111111";

// crude per-IP rate limit so nobody drains the sponsor by spamming onboardings
const hits = new Map();
const RATE = { windowMs: 60_000, max: 10 };
function rateLimited(ip) {
  const now = Date.now();
  const rec = hits.get(ip) ?? { start: now, count: 0 };
  if (now - rec.start > RATE.windowMs) { rec.start = now; rec.count = 0; }
  rec.count += 1;
  hits.set(ip, rec);
  return rec.count > RATE.max;
}

// Every instruction must be a safe onboarding step where the sponsor is only paying, never
// gaining authority. Returns null if OK, or a rejection reason.
function rejectReason(ix) {
  const pid = ix.programId.toBase58();
  if (pid === COMPUTE_PID) return null;
  if (pid === ATA_PID) {
    // createAssociatedTokenAccount layout: keys[0] = funding account (payer). It must be the
    // sponsor, and the sponsor must not be the wallet/owner (keys[2]) that ends up controlling it.
    const payer = ix.keys[0]?.pubkey;
    const owner = ix.keys[2]?.pubkey;
    if (!payer?.equals(sponsor.publicKey)) return "ATA payer must be the sponsor";
    if (owner?.equals(sponsor.publicKey)) return "sponsor cannot create an ATA it owns";
    return null;
  }
  if (pid === EXCHANGE_PID) {
    let decoded;
    try { decoded = coder.decode(ix.data, "base58"); } catch { return "undecodable exchange instruction"; }
    if (decoded?.name !== "init_open_orders") return `only init_open_orders may be sponsored, not ${decoded?.name}`;
    // accounts: [payer, owner, book, open_orders, system_program]
    const payer = ix.keys[0]?.pubkey, owner = ix.keys[1]?.pubkey;
    if (!payer?.equals(sponsor.publicKey)) return "init_open_orders payer must be the sponsor";
    if (owner?.equals(sponsor.publicKey)) return "sponsor cannot be the OpenOrders owner";
    if (!ix.keys[1]?.isSigner) return "the owner must sign for their own OpenOrders";
    return null;
  }
  return `program not sponsorable: ${pid}`;
}

const app = express();
app.use(express.json({ limit: "64kb" }));
app.use((_, res, next) => { res.set("Access-Control-Allow-Origin", "*"); res.set("Access-Control-Allow-Headers", "content-type"); next(); });
app.options("*", (_, res) => res.sendStatus(204));

app.get("/sponsor", (_, res) => res.json({ sponsor: sponsor.publicKey.toBase58(), fusdc: FUSDC }));

// Ready an embedded wallet to trade: create the token accounts it will need (sponsor pays
// the rent) and faucet it some test USDC. Creating someone's ATA needs no signature from
// them, and the sponsor is the test-USDC mint authority, so this is a pure server-side
// action. Devnet only: the faucet mints a token fischio controls, which does not exist on
// mainnet, where this becomes a real on-ramp.
app.post("/prepare", async (req, res) => {
  const ip = req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "?";
  if (rateLimited(ip)) return res.status(429).json({ error: "rate limit" });
  try {
    const owner = new PublicKey(req.body.owner);
    const mints = (req.body.mints ?? []).map((m) => new PublicKey(m)); // extra ATAs to create (e.g. YES/NO)
    const faucet = Number(req.body.faucetUsdc ?? 1000);
    for (const m of mints) await getOrCreateAssociatedTokenAccount(connection, sponsor, m, owner);
    const fusdc = new PublicKey(FUSDC);
    const ata = (await getOrCreateAssociatedTokenAccount(connection, sponsor, fusdc, owner)).address;
    let sig = null;
    if (faucet > 0) sig = await mintTo(connection, sponsor, fusdc, ata, sponsor, Math.round(faucet * 1e6));
    res.json({ ok: true, fusdcAta: ata.toBase58(), faucetUsdc: faucet, signature: sig });
  } catch (e) {
    res.status(400).json({ error: String(e.message ?? e) });
  }
});
// On-ramp: turn SOL into trading collateral. The user sends SOL to the sponsor in a normal
// transfer and posts the signature here. The sponsor confirms the SOL arrived, then mints the
// matching amount of test USDC to the sender at a fixed devnet rate. Each signature is
// honored once, so a replay cannot mint twice. On mainnet the SOL leg becomes a real payment
// (or a licensed fiat partner) and the mint becomes a real USDC transfer from treasury.
const SOL_TO_USDC = Number(process.env.SOL_TO_USDC ?? 100); // devnet demo rate: 1 SOL = 100 fUSDC
const seenBuys = new Set();
app.post("/buy", async (req, res) => {
  const ip = req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "?";
  if (rateLimited(ip)) return res.status(429).json({ error: "rate limit" });
  try {
    const sig = String(req.body.signature ?? "");
    if (!sig) return res.status(400).json({ error: "signature required" });
    if (seenBuys.has(sig)) return res.status(400).json({ error: "already processed" });
    const tx = await connection.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0 });
    if (!tx || tx.meta?.err) return res.status(400).json({ error: "payment not found or failed" });

    // find the SOL that actually landed on the sponsor in this transaction, and who sent it
    const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58());
    const idx = keys.indexOf(sponsor.publicKey.toBase58());
    if (idx < 0) return res.status(400).json({ error: "payment was not sent to the sponsor" });
    const lamports = tx.meta.postBalances[idx] - tx.meta.preBalances[idx];
    if (lamports <= 0) return res.status(400).json({ error: "no SOL received" });
    const buyer = tx.transaction.message.accountKeys.find((k) => k.signer)?.pubkey;
    if (!buyer) return res.status(400).json({ error: "no signer on the payment" });

    const usdcAmount = (lamports / 1e9) * SOL_TO_USDC;
    const fusdc = new PublicKey(FUSDC);
    const ata = (await getOrCreateAssociatedTokenAccount(connection, sponsor, fusdc, buyer)).address;
    const mintSig = await mintTo(connection, sponsor, fusdc, ata, sponsor, Math.round(usdcAmount * 1e6));
    seenBuys.add(sig);
    res.json({ ok: true, paidSol: lamports / 1e9, usdc: usdcAmount, rate: SOL_TO_USDC, signature: mintSig });
  } catch (e) {
    res.status(400).json({ error: String(e.message ?? e) });
  }
});

app.get("/health", async (_, res) => {
  const bal = await connection.getBalance(sponsor.publicKey).catch(() => null);
  res.json({ ok: true, sponsor: sponsor.publicKey.toBase58(), balanceSol: bal == null ? null : bal / 1e9, rate: SOL_TO_USDC });
});

app.post("/onboard", async (req, res) => {
  const ip = req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "?";
  if (rateLimited(ip)) return res.status(429).json({ error: "rate limit" });
  try {
    const tx = Transaction.from(Buffer.from(req.body.tx, "base64"));
    if (!tx.feePayer?.equals(sponsor.publicKey)) return res.status(400).json({ error: "fee payer must be the sponsor" });
    for (const ix of tx.instructions) {
      const reason = rejectReason(ix);
      if (reason) return res.status(400).json({ error: reason });
    }
    tx.partialSign(sponsor); // sponsor signs as rent payer + fee payer; the user already signed as owner
    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    await connection.confirmTransaction(sig, "confirmed");
    res.json({ signature: sig });
  } catch (e) {
    res.status(400).json({ error: String(e.message ?? e) });
  }
});

app.listen(PORT, () => {
  console.log(`fischio onboarding sponsor on http://127.0.0.1:${PORT}  sponsor ${sponsor.publicKey.toBase58()}`);
});
