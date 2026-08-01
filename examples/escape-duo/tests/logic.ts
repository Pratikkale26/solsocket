/* Unit tests for escape-duo's pure game logic — run with node (type stripping).
 * Includes a BFS reachability prover: for EVERY level, each puzzle element is
 * reachable exactly when its prerequisite door bits are set — so no layout
 * can ever ship with a sequence break. */
import { Keypair } from "@solana/web3.js";
import {
  COLS,
  DOOR1,
  LATCH,
  LEVELS,
  LOCK1,
  LOCK2,
  ROWS,
  TILE,
  codesFor,
  near,
  solvedKeys,
  tileUnder,
  walkable,
  type Level,
} from "../src/vault.ts";

let pass = 0;
let fail = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) pass++;
  else {
    fail++;
    console.error("FAIL:", msg);
  }
};

/** Tiles reachable from spawn walking with the given door bits / lever. */
function reachable(lv: Level, doors: number, lever: boolean): Set<string> {
  const seen = new Set<string>();
  const startC = Math.floor(lv.spawn.x / TILE);
  const startR = Math.floor(lv.spawn.y / TILE);
  const queue: [number, number][] = [[startC, startR]];
  seen.add(`${startC},${startR}`);
  while (queue.length) {
    const [c, r] = queue.pop()!;
    for (const [dc, dr] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nc = c + dc;
      const nr = r + dr;
      const key = `${nc},${nr}`;
      if (seen.has(key)) continue;
      if (!walkable(lv, nc * TILE + TILE / 2, nr * TILE + TILE / 2, doors, lever)) continue;
      seen.add(key);
      queue.push([nc, nr]);
    }
  }
  return seen;
}

const has = (set: Set<string>, lv: Level, ch: string) => {
  const p = lv.pos[ch];
  return set.has(`${Math.floor(p.x / TILE)},${Math.floor(p.y / TILE)}`);
};

for (const lv of LEVELS) {
  const L = `[${lv.name}]`;
  ok(tileUnder(lv, lv.spawn.x, lv.spawn.y) === ".", `${L} spawn on open floor`);
  for (const ch of [..."PQgGkKLSAB"]) {
    const p = lv.pos[ch];
    ok(
      lv.tile(Math.floor(p.x / TILE), Math.floor(p.y / TILE)) === ch,
      `${L} pos['${ch}'] sits on its own tile`,
    );
  }

  // phase 0: only the plates
  const p0 = reachable(lv, 0, false);
  ok(has(p0, lv, "P") && has(p0, lv, "Q"), `${L} plates reachable at start`);
  for (const ch of [..."gGkKLSAB"])
    ok(!has(p0, lv, ch), `${L} '${ch}' locked before door 1`);

  // phase 1: door 1 open → the code chamber, nothing further
  const p1 = reachable(lv, DOOR1, false);
  for (const ch of [..."gGkK"]) ok(has(p1, lv, ch), `${L} '${ch}' reachable after door 1`);
  for (const ch of [..."LSAB"]) ok(!has(p1, lv, ch), `${L} '${ch}' locked before door 2`);

  // phase 2: both locks → the lever chamber; gate still blocks
  const p2 = reachable(lv, DOOR1 | LOCK1 | LOCK2, false);
  ok(has(p2, lv, "L"), `${L} lever reachable after door 2`);
  for (const ch of [..."SAB"]) ok(!has(p2, lv, ch), `${L} '${ch}' blocked by unheld gate`);

  // phase 3a: lever held → the final chamber opens
  const p3 = reachable(lv, DOOR1 | LOCK1 | LOCK2, true);
  for (const ch of [..."SAB"]) ok(has(p3, lv, ch), `${L} '${ch}' reachable while lever held`);

  // phase 3b: latched → open without the lever
  const p4 = reachable(lv, DOOR1 | LOCK1 | LOCK2 | LATCH, false);
  for (const ch of [..."SAB"]) ok(has(p4, lv, ch), `${L} '${ch}' reachable once latched`);

  // vault door never walkable
  ok(
    !walkable(lv, 27 * TILE + TILE / 2, 5 * TILE + TILE / 2, 0xff, true),
    `${L} vault door '4' never walkable`,
  );

  // Keys are role-gated (that's the hard co-op guarantee — key A only
  // answers to the creator), but keep them visibly far apart too.
  const dist = Math.hypot(lv.pos.A.x - lv.pos.B.x, lv.pos.A.y - lv.pos.B.y);
  ok(dist >= 7 * TILE, `${L} keys ${Math.round(dist)}px apart (≥7 tiles)`);
}

ok(ROWS === 12 && COLS === 28, `all maps are ${COLS}x${ROWS}`);

// ── codes: deterministic, per-vault AND per-level ──
const addr = Keypair.generate().publicKey;
ok(
  JSON.stringify(codesFor(addr, 0)) === JSON.stringify(codesFor(addr, 0)),
  "codes deterministic",
);
ok(
  JSON.stringify(codesFor(addr, 0)) !== JSON.stringify(codesFor(addr, 1)),
  "different level, different codes",
);
ok(
  JSON.stringify(codesFor(addr, 0)) !== JSON.stringify(codesFor(Keypair.generate().publicKey, 0)),
  "different vault, different codes",
);
for (const l of [0, 1, 2]) {
  const c = codesFor(addr, l);
  ok(
    c.code1.length === 4 && c.code2.length === 4 && [...c.code1, ...c.code2].every((d) => d >= 0 && d <= 9),
    `level ${l} codes are 4 digits 0-9`,
  );
}

// ── key window per level ──
const now = Date.now();
const st = (level: number, keyA: number, keyB: number) => ({
  level,
  doors: 0,
  keyA,
  keyB,
  start: 0,
  run: 0,
});
ok(!solvedKeys(st(0, 0, 0)), "not solved at start");
ok(!solvedKeys(st(0, now, 0)), "one key is not enough");
ok(solvedKeys(st(0, now, now + 1_900)), "level 1: 1.9s apart is inside 2s window");
ok(!solvedKeys(st(0, now, now + 2_100)), "level 1: 2.1s apart fails");
ok(!solvedKeys(st(1, now, now + 1_700)), "level 2: 1.7s apart fails the 1.6s window");
ok(solvedKeys(st(1, now, now + 1_500)), "level 2: 1.5s apart passes");
ok(!solvedKeys(st(2, now, now + 1_300)), "level 3: 1.3s apart fails the 1.2s window");
ok(solvedKeys(st(2, now + 500, now)), "order doesn't matter");
ok(near(0, 0, TILE, 0, 1.5), "near() sanity");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
