// Create + accept a demo wager on the local validator so the settlement bot has
// something to settle. Maker bets P1 (USA) beats P2 (Bosnia) — USA won 2-0 IRL.
import {
  makeActor, fund, programFor, p1WinsTerms, createWager, acceptWager, STAKE,
} from "../tests/helpers.mjs";

const FIXTURE = Number(process.argv[2] ?? 18172379); // USA-Bosnia, finished 2026-07-02
const maker = makeActor();
const taker = makeActor();
await fund(maker, taker);

const program = programFor(maker);
const { wagerId, wager } = await createWager(program, maker, p1WinsTerms(FIXTURE));
await acceptWager(program, taker, maker, wagerId);

console.log(`fixture:  ${FIXTURE}`);
console.log(`maker:    ${maker.publicKey.toBase58()} (staked ${STAKE} lamports on P1 winning)`);
console.log(`taker:    ${taker.publicKey.toBase58()} (staked ${STAKE} lamports against)`);
console.log(`wager:    ${wager.toBase58()}`);
console.log(`\nnow run: node bot/settle-bot.mjs --wager ${wager.toBase58()}`);
