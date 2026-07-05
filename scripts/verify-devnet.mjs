// Confirm the devnet deploy + real oracle roots accessibility (not local clones).
import { Connection, PublicKey } from "@solana/web3.js";
import BN from "bn.js";

const RPC = "https://api.devnet.solana.com";
const PROGRAM = new PublicKey("FVVSa2AcwxBdmtKxFHiZMmd2ceRWorh7ZDdppvPsPvxb");
const TXORACLE = new PublicKey("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");

const c = new Connection(RPC, "confirmed");
const prog = await c.getAccountInfo(PROGRAM);
console.log(`wc_settle on devnet: executable=${prog?.executable} owner=${prog?.owner.toBase58()}`);

const today = Math.floor(Date.now() / 86400000);
for (const day of [today - 2, today - 1, today]) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("daily_scores_roots"), new BN(day).toArrayLike(Buffer, "le", 2)],
    TXORACLE
  );
  const acc = await c.getAccountInfo(pda);
  console.log(`roots epochDay ${day}: ${acc ? `${acc.data.length} bytes, owner ${acc.owner.toBase58().slice(0, 8)}…` : "NOT POSTED YET"}`);
}
