/* Unit tests for escape-duo's pure game logic — run with node (type stripping). */
import { Keypair } from "@solana/web3.js";
import {
  COLS,
  DOOR1,
  LATCH,
  LOCK1,
  LOCK2,
  POS,
  ROWS,
  SPAWN,
  TILE,
  codesFor,
  escaped,
  near,
  tileAt,
  tileUnder,
  walkable,
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

// ── map integrity ──
ok(ROWS === 12 && COLS === 28, `map is ${COLS}x${ROWS}`);
for (const ch of [..."PQgGkKLSAB"]) ok(!!POS[ch], `POS has '${ch}'`);
ok(tileUnder(SPAWN.x, SPAWN.y) === ".", "spawn is on open floor");

// every special tile must be reachable floor (not inside a wall)
for (const ch of [..."PQgGkKLSAB"]) {
  const p = POS[ch];
  const t = tileAt(Math.floor(p.x / TILE), Math.floor(p.y / TILE));
  ok(t === ch, `POS['${ch}'] sits on its own tile (got '${t}')`);
}

// ── door gating ──
const doorCol = (ch: string) => {
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++) if (tileAt(c, r) === ch) return { c, r };
  throw new Error(`no '${ch}'`);
};
const d1 = doorCol("1");
const d2 = doorCol("2");
const d3 = doorCol("3");
const px = (c: number) => c * TILE + TILE / 2;
ok(!walkable(px(d1.c), px(d1.r), 0, false), "door1 blocked at start");
ok(walkable(px(d1.c), px(d1.r), DOOR1, false), "door1 open with DOOR1 bit");
ok(!walkable(px(d2.c), px(d2.r), DOOR1 | LOCK1, false), "door2 needs BOTH locks");
ok(walkable(px(d2.c), px(d2.r), DOOR1 | LOCK1 | LOCK2, false), "door2 open with both locks");
ok(!walkable(px(d3.c), px(d3.r), DOOR1 | LOCK1 | LOCK2, false), "gate3 blocked unheld");
ok(walkable(px(d3.c), px(d3.r), DOOR1 | LOCK1 | LOCK2, true), "gate3 passable while lever held");
ok(walkable(px(d3.c), px(d3.r), DOOR1 | LOCK1 | LOCK2 | LATCH, false), "gate3 open once latched");
ok(!walkable(px(27), px(5), 0xff, true), "vault door '4' never walkable");

// left chamber is sealed without door1: no path check needed — the whole
// column 7 must block except door tiles
for (let r = 1; r < ROWS - 1; r++) {
  const t = tileAt(7, r);
  ok(t === "#" || t === "1", `col 7 row ${r} seals chamber 1 (got '${t}')`);
}
for (let r = 1; r < ROWS - 1; r++) {
  const t = tileAt(14, r);
  ok(t === "#" || t === "2", `col 14 row ${r} seals chamber 2 (got '${t}')`);
}
for (let r = 1; r < ROWS - 1; r++) {
  const t = tileAt(20, r);
  ok(t === "#" || t === "3", `col 20 row ${r} seals chamber 3 (got '${t}')`);
}

// switch S must be BEYOND gate 3 (col > 20) so it can't be latched early
ok(POS.S.x > 20 * TILE, "switch S is past gate 3");
// lever L must be BEFORE gate 3
ok(POS.L.x < 20 * TILE, "lever L is before gate 3");
// keys must not be reachable from each other within the 2s window by one
// player: A and B are 6+ tiles apart
ok(!near(POS.A.x, POS.A.y, POS.B.x, POS.B.y, 5), "keys A and B are far apart");

// ── codes ──
const addr = Keypair.generate().publicKey;
const c1 = codesFor(addr);
const c2 = codesFor(addr);
ok(JSON.stringify(c1) === JSON.stringify(c2), "codes deterministic per address");
ok(c1.code1.length === 4 && c1.code2.length === 4, "codes are 4 digits");
ok(c1.code1.every((d) => d >= 0 && d <= 9), "digits 0-9");
const other = codesFor(Keypair.generate().publicKey);
ok(JSON.stringify(c1) !== JSON.stringify(other), "different vault, different codes");

// ── escape condition ──
const now = Date.now();
ok(!escaped({ doors: 0, keyA: 0, keyB: 0, start: 0 }), "not escaped at start");
ok(!escaped({ doors: 0, keyA: now, keyB: 0, start: 0 }), "one key is not enough");
ok(escaped({ doors: 0, keyA: now, keyB: now + 1_900, start: 0 }), "both keys within 2s");
ok(!escaped({ doors: 0, keyA: now, keyB: now + 2_100, start: 0 }), "2.1s apart fails");
ok(escaped({ doors: 0, keyA: now + 500, keyB: now, start: 0 }), "order doesn't matter");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
