// Does this test suite actually work?
//
// A suite that always passes is indistinguishable from a suite that is not running. Both print
// green. Every failure mode here is real and quiet: a runner whose glob matches no files, an
// await that was forgotten so the assertion settles after the test ended, a helper that
// swallows the thing it was meant to check, or a skip that fires because a credential is
// missing and nobody reads the word "skipped".
//
// So this file proves the machinery by using it. It runs a deliberately failing test in a real
// subprocess and checks that the runner notices, and that the process exits non-zero, which is
// the only signal continuous integration actually reads.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The child has to run as if nobody were watching.
//
// `node --test` puts NODE_TEST_CONTEXT in the environment of everything it spawns. A child that
// sees it assumes it is a worker of the outer run, switches to the serialised reporter, and
// hands its result up the chain instead of failing on its own terms. Measured here: the same
// deliberately failing file exits 1 from a shell and exited 0 from inside this suite, which is
// precisely the false green this file exists to catch. It caught itself.
function cleanEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  delete env.FISCHIO_CANARY; // never let an armed canary leak into a child
  return env;
}

test("a false assertion really does throw", () => {
  // If this passes silently, nothing else in the suite means anything.
  assert.throws(() => assert.equal(1, 2), { name: "AssertionError" });
  assert.throws(() => assert.ok(false), { name: "AssertionError" });
  assert.throws(() => assert.deepEqual({ a: 1 }, { a: 2 }), { name: "AssertionError" });
});

test("a rejected promise is caught rather than lost", async () => {
  // The classic silent pass: an async assertion nobody awaited. The test ends green and the
  // rejection lands somewhere nobody is looking.
  await assert.rejects(async () => { throw new Error("boom"); }, /boom/);
  let caught = false;
  try { await Promise.reject(new Error("unhandled")); } catch { caught = true; }
  assert.ok(caught, "a rejection escaped a try/catch, so async failures may be going missing");
});

test("a failing test exits non-zero, which is the only thing CI reads", () => {
  // The real question. Not "does assert throw", but "does a thrown assertion travel all the way
  // out of the runner and turn the exit code red". A suite whose failures never reach the exit
  // code is a suite that cannot block a bad merge, however much red it prints.
  //
  // This has to run in its own process. A failing subtest inside this file would mark this file
  // failed, which is exactly what we do not want.
  const dir = mkdtempSync(join(tmpdir(), "fischio-canary-"));
  const file = join(dir, "deliberate-failure.test.mjs");
  try {
    writeFileSync(file, [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'test("this one is supposed to fail", () => { assert.equal("red", "green"); });',
    ].join("\n"));

    const r = spawnSync(process.execPath, ["--test", file], { encoding: "utf8", env: cleanEnv() });
    assert.notEqual(r.status, 0, "a test failed and the runner still exited zero; nothing here can block a bad change");
    assert.match(`${r.stdout}${r.stderr}`, /fail 1|not ok/, "the failure did not appear in the runner's output");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a passing test exits zero, so the check above is not just always red", () => {
  // The other half. Without this, the test above would pass even if every run failed.
  const dir = mkdtempSync(join(tmpdir(), "fischio-canary-"));
  const file = join(dir, "deliberate-pass.test.mjs");
  try {
    writeFileSync(file, [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'test("this one is supposed to pass", () => { assert.equal(2 + 2, 4); });',
    ].join("\n"));

    const r = spawnSync(process.execPath, ["--test", file], { encoding: "utf8", env: cleanEnv() });
    assert.equal(r.status, 0, "a passing test did not exit zero, so the runner is misreporting");
    assert.match(`${r.stdout}${r.stderr}`, /pass 1/, "the subprocess exited zero without running anything, which would make the check above meaningless");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The canary. Fails on purpose, only when armed, so a person can watch a red run travel through
// the scripts and whatever is reporting them. CI leaves it skipped.
//
//   FISCHIO_CANARY=1 npm run test:canary
test("canary: fail on demand to prove a red run is visible", { skip: process.env.FISCHIO_CANARY !== "1" && "set FISCHIO_CANARY=1 to arm this" }, () => {
  assert.fail("the canary fired, which means a failing test really does turn this suite red");
});
