// Read layer + instruction wiring for the shell views. Uses ONLY the existing
// program instructions; no new money paths. Reads are real devnet state.
import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, SystemProgram } from "@solana/web3.js";
import idl from "./idl.json";
import fixturesFile from "./fixtures.json";

const params = new URLSearchParams(window.location.search);
// RPC precedence: ?rpc= override, then VITE_RPC from .env.local (a paid endpoint like Alchemy,
// kept out of the committed source), then the throttled public devnet as a last resort.
export const RPC = params.get("rpc") ?? import.meta.env.VITE_RPC ?? "https://api.devnet.solana.com";
export const connection = new Connection(RPC, "confirmed");

export const FIXTURES_BY_ID = new Map(fixturesFile.fixtures.map((f) => [f.id, f]));
export const UPCOMING = fixturesFile.fixtures.filter((f) => new Date(f.kickoff) > new Date());

const BN = anchor.BN;

// read-only program: account fetches need no signer
const readProvider = new anchor.AnchorProvider(
  connection,
  { publicKey: PublicKey.default, signTransaction: async (t) => t, signAllTransactions: async (t) => t },
  { commitment: "confirmed" }
);
export const readProgram = new anchor.Program(idl, readProvider);

export const programFor = (anchorWallet) =>
  new anchor.Program(idl, new anchor.AnchorProvider(connection, anchorWallet, { commitment: "confirmed" }));

const fmtKickoff = (iso) => (iso ? iso.slice(0, 16).replace("T", " ") + " UTC" : "");

/// on-chain account -> Ticket props (fixture names from the real feed snapshot)
export function toTicket(pubkey, acc) {
  const fixtureId = acc.terms.fixtureId.toNumber();
  const fx = FIXTURES_BY_ID.get(fixtureId);
  return {
    address: pubkey.toBase58(),
    fixtureId,
    home: fx?.home ?? "Home",
    away: fx?.away ?? "Away",
    kickoff: fx ? fmtKickoff(fx.kickoff) : "",
    finalScore: null,
    maker: acc.maker.toBase58(),
    taker: acc.taker.toBase58(),
    stakeLamports: acc.stakeLamports.toNumber(),
    tipLamports: 100_000,
    state: Object.keys(acc.state)[0], // open | active | settled | refunded
    expiryTs: acc.expiryTs.toNumber(),
    wagerId: acc.wagerId,
    settleSig: "",
    settler: "",
    provenLeaves: [],
  };
}

export async function fetchAllWagers() {
  const all = await readProgram.account.wager.all();
  return all.map(({ publicKey, account }) => toTicket(publicKey, account));
}

export function wagerPdas(programId, makerPk, wagerId) {
  const wager = PublicKey.findProgramAddressSync(
    [Buffer.from("wager"), makerPk.toBuffer(), new BN(wagerId.toString()).toArrayLike(Buffer, "le", 8)],
    programId
  )[0];
  const vault = PublicKey.findProgramAddressSync([Buffer.from("vault"), wager.toBuffer()], programId)[0];
  return { wager, vault };
}

/// existing create_wager instruction via the connected wallet (no new money paths)
export async function createWagerTx(anchorWallet, { fixtureId, backedIsHome, stakeLamports, expiryTs }) {
  const program = programFor(anchorWallet);
  const wagerId = (BigInt(Date.now()) << 8n) + BigInt(Math.floor(Math.random() * 256));
  const { wager, vault } = wagerPdas(program.programId, anchorWallet.publicKey, wagerId);
  // canonical market: backed side beats the other in 90'+ET, pens = taker's win.
  // Backing the away side swaps the stat keys; predicate stays GT 0.
  const terms = {
    fixtureId: new BN(fixtureId),
    statAKey: backedIsHome ? 1 : 2,
    statBKey: backedIsHome ? 2 : 1,
    op: { subtract: {} },
    predicate: { threshold: 0, comparison: { greaterThan: {} } },
  };
  const sig = await program.methods
    .createWager(new BN(wagerId.toString()), terms, new BN(stakeLamports), new BN(expiryTs))
    .accountsPartial({ maker: anchorWallet.publicKey, wager, vault, systemProgram: SystemProgram.programId })
    .rpc();
  return { sig, wager: wager.toBase58() };
}

/// existing accept_wager instruction via the connected wallet
export async function acceptWagerTx(anchorWallet, ticket) {
  const program = programFor(anchorWallet);
  const { wager, vault } = wagerPdas(program.programId, new PublicKey(ticket.maker), ticket.wagerId);
  return program.methods
    .acceptWager()
    .accountsPartial({ taker: anchorWallet.publicKey, wager, vault, systemProgram: SystemProgram.programId })
    .rpc();
}

/// settled outcome for the account view: pure read of the wager PDA's tx history.
/// Winner is not stored on-chain (deliberate minimal state); the settle tx's balance
/// deltas identify who was paid.
export async function fetchOutcome(ticket) {
  const sigs = await connection.getSignaturesForAddress(new PublicKey(ticket.address), { limit: 10 });
  for (const s of sigs) {
    if (s.err) continue;
    const tx = await connection.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
    if (!tx?.meta) continue;
    const keys = tx.transaction.message.staticAccountKeys ?? tx.transaction.message.accountKeys;
    const delta = (pk) => {
      const i = keys.findIndex((k) => k.toBase58() === pk);
      return i === -1 ? 0 : tx.meta.postBalances[i] - tx.meta.preBalances[i];
    };
    const makerDelta = delta(ticket.maker);
    const takerDelta = delta(ticket.taker);
    if (makerDelta > 0 || takerDelta > 0) {
      return {
        sig: s.signature,
        winner: makerDelta >= takerDelta ? "maker" : "taker",
        paidLamports: Math.max(makerDelta, takerDelta),
      };
    }
  }
  return null;
}

/// Reconstruct a settlement receipt from chain alone: the wager account plus its
/// settle transaction, with the proven score and phase recovered by decoding the
/// settle instruction bytes. Nothing is stored off-chain.
async function decodeSettleInto(ticket) {
  try {
    const tx = await connection.getTransaction(ticket.settleSig, { maxSupportedTransactionVersion: 0 });
    const msg = tx.transaction.message;
    const keys = msg.staticAccountKeys ?? msg.accountKeys;
    ticket.settler = keys[0].toBase58(); // fee payer = the permissionless settler
    const progIdx = keys.findIndex((k) => k.toBase58() === readProgram.programId.toBase58());
    const compiled = msg.compiledInstructions
      ? msg.compiledInstructions.map((ix) => ({ pi: ix.programIdIndex, data: Buffer.from(ix.data) }))
      : msg.instructions.map((ix) => ({ pi: ix.programIdIndex, data: Buffer.from(anchor.utils.bytes.bs58.decode(ix.data)) }));
    const ours = compiled.find((ix) => ix.pi === progIdx);
    const decoded = readProgram.coder.instruction.decode(ours.data);
    if (decoded?.name === "settle") {
      const d = decoded.data;
      const a = d.statA.statToProve;
      const b = d.statB?.statToProve;
      ticket.provenLeaves = b ? [a, b] : [a];
      if (b) ticket.finalScore = [a.value, b.value];
      // The full Merkle proof travels inside the settle instruction bytes, so the
      // settlement is re-verifiable from chain alone (see ProofPanel / verifyProof.js).
      ticket.proof = {
        meta: { home: ticket.home, away: ticket.away, settleSig: ticket.settleSig },
        statA: { statToProve: a, eventStatRoot: d.statA.eventStatRoot, statProof: d.statA.statProof },
        statB: b
          ? { statToProve: b, eventStatRoot: d.statB.eventStatRoot, statProof: d.statB.statProof }
          : null,
        subTreeProof: d.fixtureProof,
        eventsSubTreeRoot: d.fixtureSummary?.eventsSubTreeRoot,
      };
    }
  } catch {
    // receipt still renders with sig + parties; leaves stay empty if decode fails
  }
}

/// Every settlement this program has executed, newest first, decoded from chain.
/// Memoized per session: three views share one scan instead of tripling RPC load
/// against the rate-limited public endpoint.
let settlementsPromise = null;
export function fetchSettlements(force = false) {
  if (force || !settlementsPromise) settlementsPromise = scanSettlements();
  return settlementsPromise;
}

async function scanSettlements() {
  const all = await readProgram.account.wager.all();
  const settled = all.filter(({ account }) => "settled" in account.state);
  const out = [];
  for (const { publicKey, account } of settled) {
    const sigs = await connection.getSignaturesForAddress(publicKey, { limit: 10 });
    const s = sigs.find((x) => !x.err); // last successful write = the settle tx
    if (!s) continue;
    const ticket = toTicket(publicKey, account);
    ticket.settleSig = s.signature;
    ticket.blockTime = s.blockTime ?? 0;
    await decodeSettleInto(ticket);
    out.push(ticket);
  }
  return out.sort((a, b) => b.blockTime - a.blockTime);
}

export async function fetchLatestSettlement() {
  return (await fetchSettlements())[0] ?? null;
}

/// Live fixtures via the serverless proxy; bundled snapshot is the offline fallback.
/// Updates the shared fixture map in place so tickets rendered afterwards resolve
/// names from fresh data.
export async function refreshFixtures() {
  try {
    const r = await fetch("/api/fixtures");
    if (!r.ok) throw new Error(String(r.status));
    const { fixtures } = await r.json();
    FIXTURES_BY_ID.clear();
    for (const f of fixtures) FIXTURES_BY_ID.set(f.id, f);
    return fixtures.filter((f) => new Date(f.kickoff) > new Date());
  } catch {
    return UPCOMING; // bundled snapshot; refreshed at build time by scripts/refresh-fixtures.mjs
  }
}

/// Compact live scores for the fixtures on visible tickets. Serverless proxy only;
/// silently absent in local dev or when the proxy is unconfigured.
export async function fetchLiveScores(fixtureIds) {
  if (!fixtureIds.length) return {};
  try {
    const r = await fetch(`/api/scores?ids=${fixtureIds.join(",")}`);
    if (!r.ok) return {};
    return (await r.json()).scores ?? {};
  } catch {
    return {};
  }
}
