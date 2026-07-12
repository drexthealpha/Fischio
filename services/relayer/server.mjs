// fischio gasless relayer. The user signs only their instruction; this service signs as
// fee payer and pays the gas, so trading costs the user nothing. It can never move user
// funds: it is the fee payer, not an authority on anything. It only co-signs transactions
// that touch fischio programs, so nobody can drain it paying for arbitrary transactions.
//
//   GET  /feepayer   the relayer pubkey (the frontend sets this as the tx fee payer)
//   GET  /health     pubkey, balance, allowed programs
//   POST /relay      { tx: base64 } user-signed tx; relayer co-signs and submits
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import express from "express";
import { Connection, Keypair, Transaction, PublicKey } from "@solana/web3.js";

const here = dirname(fileURLToPath(import.meta.url));
const RPC = process.env.RPC ?? "https://api.devnet.solana.com";
const PORT = Number(process.env.PORT ?? 8791);
const connection = new Connection(RPC, "confirmed");
const relayer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(join(here, "relayer-key.json"), "utf8"))));

// only pay for transactions that touch these programs
const ALLOWED = new Set([
  "FVVSa2AcwxBdmtKxFHiZMmd2ceRWorh7ZDdppvPsPvxb", // wc-settle
  "AweLznQDPzt9UXKhon6X8iKgvrd5dX4Ru36ddnuRirKZ", // market (AMM)
  "7PtxtGEGwBsSNRcRDsP4pedkQkzpGLZNv92Ndc9WwgrE", // exchange (CLOB)
  "8zVnp7ivs5fSdmjYFHTLChrSzbKnDeKX6mj5nuP1CAgg", // multi (NegRisk)
  "HUXM89x5Uxex2XfTh58i2xXzroeULgtuq7w3tT7zzYpJ", // oracle
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",  // SPL Token
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",  // Associated Token
  "11111111111111111111111111111111",             // System
  "ComputeBudget111111111111111111111111111111",  // Compute Budget
]);

// crude per-IP rate limit so nobody drains the relayer's SOL by spamming
const hits = new Map();
const RATE = { windowMs: 60_000, max: 30 };
function rateLimited(ip) {
  const now = Date.now();
  const rec = hits.get(ip) ?? { start: now, count: 0 };
  if (now - rec.start > RATE.windowMs) { rec.start = now; rec.count = 0; }
  rec.count += 1;
  hits.set(ip, rec);
  return rec.count > RATE.max;
}

const app = express();
app.use(express.json({ limit: "64kb" }));
app.use((_, res, next) => { res.set("Access-Control-Allow-Origin", "*"); res.set("Access-Control-Allow-Headers", "content-type"); next(); });
app.options("*", (_, res) => res.sendStatus(204));

app.get("/feepayer", (_, res) => res.json({ feePayer: relayer.publicKey.toBase58() }));
app.get("/health", async (_, res) => {
  const bal = await connection.getBalance(relayer.publicKey).catch(() => null);
  res.json({ ok: true, feePayer: relayer.publicKey.toBase58(), balanceSol: bal == null ? null : bal / 1e9, allowed: [...ALLOWED].slice(0, 5) });
});

app.post("/relay", async (req, res) => {
  const ip = req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "?";
  if (rateLimited(ip)) return res.status(429).json({ error: "rate limit" });
  try {
    const raw = Buffer.from(req.body.tx, "base64");
    const tx = Transaction.from(raw);

    if (!tx.feePayer?.equals(relayer.publicKey)) {
      return res.status(400).json({ error: "fee payer must be the relayer" });
    }
    for (const ix of tx.instructions) {
      if (!ALLOWED.has(ix.programId.toBase58())) {
        return res.status(400).json({ error: `program not allowed: ${ix.programId.toBase58()}` });
      }
    }
    // the relayer must not be an authority signer beyond fee payment
    const extraRelayerSig = tx.instructions.some((ix) =>
      ix.keys.some((k) => k.isSigner && k.pubkey.equals(relayer.publicKey)));
    if (extraRelayerSig) return res.status(400).json({ error: "relayer cannot be an instruction signer" });

    tx.partialSign(relayer); // adds only the fee-payer signature; user signatures are already present
    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    await connection.confirmTransaction(sig, "confirmed");
    res.json({ signature: sig });
  } catch (e) {
    res.status(400).json({ error: String(e.message ?? e) });
  }
});

app.listen(PORT, () => {
  console.log(`fischio relayer on http://127.0.0.1:${PORT}  fee payer ${relayer.publicKey.toBase58()}`);
});
