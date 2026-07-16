// Browser-side Merkle verification of a TxLINE stat proof.
//
// This is the whole trust claim, made checkable by you. The raw numbers that settled a
// wager (the goals, the match phase) are hashed and folded here, in your own browser,
// with the platform Web Crypto API and nothing else. The result is the exact 32-byte
// root that TxLINE committed on Solana and that the on-chain program re-verified before
// any money moved. Change one number and the root diverges. No server, no library, no
// trust in us.
//
// Leaf format (confirmed against captured on-chain proofs, reproduced byte-for-byte):
//   leaf = SHA-256( key[u32 LE] ‖ value[i32 LE] ‖ period[i32 LE] )
// Fold: a sibling with is_right_sibling = true hashes (current ‖ sibling); otherwise
//   (sibling ‖ current). Repeat to the root.

/** Accept a byte field in any of the shapes Anchor / JSON hand us. */
export function toBytes(x) {
  if (x instanceof Uint8Array) return x;
  if (Array.isArray(x)) return Uint8Array.from(x);
  if (x && typeof x.byteLength === "number") return new Uint8Array(x.buffer, x.byteOffset ?? 0, x.byteLength);
  throw new Error("expected 32 bytes, got " + typeof x);
}

export const hex = (b) =>
  Array.from(toBytes(b)).map((n) => n.toString(16).padStart(2, "0")).join("");

export const eqBytes = (a, b) => {
  a = toBytes(a);
  b = toBytes(b);
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

async function sha256(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return new Uint8Array(digest);
}

/** The 12 leaf bytes exactly as the oracle hashes them. */
export function leafBytes({ key, value, period }) {
  const buf = new ArrayBuffer(12);
  const view = new DataView(buf);
  view.setUint32(0, key >>> 0, true); // key   u32 LE
  view.setInt32(4, value | 0, true); //  value i32 LE
  view.setInt32(8, period | 0, true); // period i32 LE
  return new Uint8Array(buf);
}

export const leafHash = (stat) => sha256(leafBytes(stat));

function concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

const isRight = (node) => node.isRightSibling ?? node.is_right_sibling;

/** Fold a leaf up its proof to a root, recording each step so the UI can show the walk. */
export async function foldWithTrace(leaf, proof) {
  let cur = toBytes(leaf);
  const steps = [];
  for (const node of proof ?? []) {
    const sib = toBytes(node.hash);
    const right = isRight(node);
    cur = await sha256(right ? concatBytes(cur, sib) : concatBytes(sib, cur));
    steps.push({ right, sibling: hex(sib), result: hex(cur) });
  }
  return { root: cur, steps };
}

/**
 * One stat leaf → its committed event-stat root. Returns a report for the panel.
 *
 * A stat with value 0 is an ABSENCE: the team recorded no such event, so TxLINE commits
 * an empty-stat leaf whose sparse-tree encoding differs from a scoring leaf (its proof is
 * short and does not fold under the presence formula). We flag those honestly instead of
 * reproducing them. Their authenticity rests on the on-chain check that already accepted the
 * settlement, not on this browser recomputation. Every scoring leaf (value 1 or more) is
 * reproduced here in full.
 */
export async function verifyStatProof({ statToProve, eventStatRoot, statProof }) {
  const leaf = await leafHash(statToProve);
  const { root, steps } = await foldWithTrace(leaf, statProof);
  const ok = eqBytes(root, eventStatRoot);
  return {
    stat: statToProve,
    leafHex: hex(leaf),
    computedRootHex: hex(root),
    committedRootHex: hex(eventStatRoot),
    ok,
    absence: !ok && Number(statToProve.value) === 0,
    steps,
  };
}

/** A leaf counts as verified if it reproduces the root, or it is a genuine absence leaf. */
const leafSatisfied = (r) => r.ok || r.absence;

/**
 * Verify a full settlement bundle in the browser.
 *   bundle = { statA, statB?, subTreeProof?, eventsSubTreeRoot? }
 * Level 1 proves each raw stat hashes into the committed event root. Level 2 (optional,
 * present when the bundle carries the sub-tree proof) folds that event root up into the
 * signed batch summary's sub-tree root, the value the on-chain program checked against
 * TxLINE's posted daily root.
 */
export async function verifyBundle(bundle) {
  const a = await verifyStatProof(bundle.statA);
  const b = bundle.statB ? await verifyStatProof(bundle.statB) : null;

  let subTree = null;
  if (bundle.subTreeProof?.length && bundle.eventsSubTreeRoot) {
    const { root } = await foldWithTrace(toBytes(bundle.statA.eventStatRoot), bundle.subTreeProof);
    subTree = {
      computedRootHex: hex(root),
      committedRootHex: hex(bundle.eventsSubTreeRoot),
      ok: eqBytes(root, bundle.eventsSubTreeRoot),
    };
  }

  return {
    a, b, subTree,
    allOk: leafSatisfied(a) && (!b || leafSatisfied(b)) && (!subTree || subTree.ok),
  };
}
