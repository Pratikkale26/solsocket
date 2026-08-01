import { PublicKey } from "@solana/web3.js";

/** Escape levels. Every layout is 28×12 and carries the same puzzle chars:
 *  `#` wall  `.` floor  `1` plate door  `2` code door  `3` held gate
 *  `4` vault door  `P`/`Q` pressure plates  `g`/`G` code panels  `k`/`K`
 *  keypads  `L` lever  `S` gate switch  `A`/`B` key stations
 *  Terrain hazards (level flavor): `~` coolant — stepping on it resets you
 *  to spawn; `m` pulse barrier — passable only while the pulse is open,
 *  clocked off the run's onchain start timestamp so every client agrees. */
export const TILE = 24;
export const COLS = 28;
export const ROWS = 12;
export const WIDTH = COLS * TILE;
export const HEIGHT = ROWS * TILE;

interface LevelDef {
  name: string;
  keyWindowMs: number;
  spawnTile: { c: number; r: number };
  layout: string[];
}

const DEFS: LevelDef[] = [
  {
    name: "The Vault",
    keyWindowMs: 2_000,
    spawnTile: { c: 3, r: 5 },
    layout: [
      "############################",
      "#......#......#.....#..A...#",
      "#..P...#..g...#.....#......#",
      "#......#......#..L..#......#",
      "#......1..k...2.....3.S....#",
      "#......1......2.....3......4",
      "#......1......2.....3......4",
      "#......#..K...#.....#......#",
      "#..Q...#......#.....#......#",
      "#......#..G...#.....#......#",
      "#......#......#.....#..B...#",
      "############################",
    ],
  },
  {
    name: "The Reactor",
    keyWindowMs: 1_600,
    spawnTile: { c: 5, r: 4 },
    layout: [
      "############################",
      "#....P.#..K...#.....#..B...#",
      "#..##..#.~~...#.##..#......#",
      "#..#...#..G...#.....#..##..#",
      "#..#...1......2..L..3...#..#",
      "#..##..1.~~~..2.....3...#..4",
      "#...#..1......2.....3..##..4",
      "#...#..#..g...#.##..#......#",
      "#...#..#.~~...#.....#.S....#",
      "#......#..k...#..~..#......#",
      "#....Q.#......#.....#..A...#",
      "############################",
    ],
  },
  {
    name: "The Core",
    keyWindowMs: 1_200,
    spawnTile: { c: 2, r: 2 },
    layout: [
      "############################",
      "#P....##...k..#..L..#.A....#",
      "#.....##......#.....#.m.m..#",
      "#.##...##mmmmm#..#..#..#####",
      "#......1..g...2..#..3......#",
      "#.###..1......2..#..3......4",
      "#...#..1......2.....3..###.4",
      "#......#..G...#.....#....#.#",
      "#..##..#.~~...#..#..#....#.#",
      "#......#...K..#.....#.S..#.#",
      "#....Q.#......#.....#....B.#",
      "############################",
    ],
  },
];

export interface Level {
  index: number;
  name: string;
  keyWindowMs: number;
  spawn: { x: number; y: number };
  pos: Record<string, { x: number; y: number }>;
  tile(c: number, r: number): string;
}

function build(def: LevelDef, index: number): Level {
  if (def.layout.length !== ROWS) throw new Error(`${def.name}: needs ${ROWS} rows`);
  for (const row of def.layout)
    if (row.length !== COLS) throw new Error(`${def.name}: row length ${row.length} !== ${COLS}`);
  const pos: Record<string, { x: number; y: number }> = {};
  for (const ch of [..."PQgGkKLSAB"]) {
    let found = 0;
    for (let r = 0; r < ROWS; r++) {
      const c = def.layout[r].indexOf(ch);
      if (c >= 0) {
        found += 1;
        pos[ch] = { x: c * TILE + TILE / 2, y: r * TILE + TILE / 2 };
        if (def.layout[r].indexOf(ch, c + 1) >= 0) found += 1;
      }
    }
    if (found !== 1) throw new Error(`${def.name}: needs exactly one '${ch}' (found ${found})`);
  }
  const tile = (c: number, r: number) =>
    c < 0 || c >= COLS || r < 0 || r >= ROWS ? "#" : def.layout[r][c];
  return {
    index,
    name: def.name,
    keyWindowMs: def.keyWindowMs,
    spawn: { x: def.spawnTile.c * TILE + TILE / 2, y: def.spawnTile.r * TILE + TILE / 2 },
    pos,
    tile,
  };
}

export const LEVELS: Level[] = DEFS.map(build);

/** Shared vault state — one binary struct the whole run agrees on. */
export type VaultState = {
  level: number; // current level index — both players always move together
  doors: number; // progress bitfield, per level
  keyA: number; // ms timestamp of key A's last turn
  keyB: number;
  start: number; // ms timestamp: this level's clock
  run: number; // ms timestamp: the whole run's clock (set once, level 0)
};
export const DOOR1 = 1; // both plates pressed at once
export const LOCK1 = 2; // keypad k solved
export const LOCK2 = 4; // keypad K solved
export const LATCH = 8; // gate switch hit — gate 3 stays open

export const levelOf = (s: VaultState): Level =>
  LEVELS[Math.min(Math.max(s.level, 0), LEVELS.length - 1)];

/** Pulse barriers (`m`) open and close on a fixed cycle anchored to the
 *  run's onchain start timestamp — deterministic, so every client (and
 *  every spectator) sees the same phase with no extra messages. */
export const PULSE_MS = 1_700;
export const pulseOpen = (runTs: number, now: number) =>
  runTs === 0 || Math.floor((now - runTs) / PULSE_MS) % 2 === 0;

/** Both keys turned inside this level's window? */
export const solvedKeys = (s: VaultState) =>
  s.keyA > 0 && s.keyB > 0 && Math.abs(s.keyA - s.keyB) <= levelOf(s).keyWindowMs;

export const isFinal = (s: VaultState) => s.level >= LEVELS.length - 1;

export const tileUnder = (lv: Level, x: number, y: number) =>
  lv.tile(Math.floor(x / TILE), Math.floor(y / TILE));

export function walkable(
  lv: Level,
  x: number,
  y: number,
  doors: number,
  leverHeld: boolean,
  pulse = true,
  half = 8,
): boolean {
  for (const [dx, dy] of [
    [-half, -half],
    [half, -half],
    [-half, half],
    [half, half],
  ] as const) {
    const t = lv.tile(Math.floor((x + dx) / TILE), Math.floor((y + dy) / TILE));
    if (t === "#" || t === "4") return false;
    if (t === "1" && !(doors & DOOR1)) return false;
    if (t === "2" && !(doors & LOCK1 && doors & LOCK2)) return false;
    if (t === "3" && !(doors & LATCH) && !leverHeld) return false;
    if (t === "m" && !pulse) return false;
    // `~` is deliberately walkable — stepping on it is the mistake.
  }
  return true;
}

export function near(ax: number, ay: number, bx: number, by: number, tiles: number): boolean {
  const r = tiles * TILE;
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy <= r * r;
}

/** The two 4-digit codes for a level, derived from the room address — same
 *  for every client, different per vault AND per level. Each player can only
 *  SEE the code their partner must type: the relay is the puzzle. */
export function codesFor(room: PublicKey, level: number): { code1: number[]; code2: number[] } {
  const b = room.toBytes();
  const o = (level * 8) % 24;
  return {
    code1: [...b.slice(o, o + 4)].map((n) => n % 10),
    code2: [...b.slice(o + 4, o + 8)].map((n) => n % 10),
  };
}

export interface DrawOpts {
  t: number;
  doors: number;
  frozen: boolean; // level solved — pose for the overlay
  role: number; // 0 or 1 — decides which panel/keypad is "yours"
  seeCode: number[]; // the code THIS viewer can read off their panel
  buf: string; // digits typed so far on the viewer's keypad
  meTile: string;
  partnerTile: string;
  keyA: number;
  keyB: number;
  keyWindowMs: number;
  /** Are the `m` pulse barriers currently open? */
  pulseOn: boolean;
}

const shade = (c: number, r: number) => (c * 7 + r * 13) % 3;

export function drawVault(ctx: CanvasRenderingContext2D, lv: Level, o: DrawOpts) {
  const gateOpen =
    (o.doors & LATCH) !== 0 || o.meTile === "L" || o.partnerTile === "L";

  const floor = (x: number, y: number, v: number) => {
    ctx.fillStyle = ["#262833", "#292b37", "#242631"][v];
    ctx.fillRect(x, y, TILE, TILE);
  };

  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const x = c * TILE;
      const y = r * TILE;
      const v = shade(c, r);
      const ch = lv.tile(c, r);
      switch (ch) {
        case "#": {
          ctx.fillStyle = ["#3d4150", "#424656", "#393d4b"][v];
          ctx.fillRect(x, y, TILE, TILE);
          ctx.fillStyle = "#31343f";
          ctx.fillRect(x, y + TILE - 4, TILE, 4);
          break;
        }
        case "1":
        case "2":
        case "3": {
          const open =
            ch === "1"
              ? (o.doors & DOOR1) !== 0
              : ch === "2"
                ? (o.doors & LOCK1) !== 0 && (o.doors & LOCK2) !== 0
                : gateOpen;
          if (open) {
            floor(x, y, v);
            ctx.fillStyle = "rgba(74,222,128,0.25)";
            ctx.fillRect(x, y, 3, TILE);
            ctx.fillRect(x + TILE - 3, y, 3, TILE);
          } else {
            ctx.fillStyle = "#4a4f63";
            ctx.fillRect(x, y, TILE, TILE);
            ctx.fillStyle = "#f87171";
            for (let i = 0; i < 3; i++) ctx.fillRect(x + 3, y + 4 + i * 7, TILE - 6, 3);
          }
          break;
        }
        case "4": {
          ctx.fillStyle = o.frozen ? "#141520" : "#8a6d1f";
          ctx.fillRect(x, y, TILE, TILE);
          if (!o.frozen) {
            ctx.strokeStyle = "#d4a017";
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(x + TILE / 2, y + TILE / 2, 7, 0, Math.PI * 2);
            ctx.stroke();
          }
          break;
        }
        case "~": {
          // coolant — touch it and you're back at spawn
          const glow = 38 + Math.sin(o.t / 260 + c * 1.1 + r * 0.7) * 8;
          ctx.fillStyle = `hsl(14 85% ${glow}%)`;
          ctx.fillRect(x, y, TILE, TILE);
          ctx.fillStyle = "rgba(255,255,255,0.25)";
          ctx.fillRect(x + 4, y + 10 + Math.sin(o.t / 300 + c) * 3, TILE - 8, 2);
          break;
        }
        case "m": {
          floor(x, y, v);
          if (o.pulseOn) {
            // open: just the emitter studs
            ctx.fillStyle = "#22d3ee";
            ctx.fillRect(x + TILE / 2 - 1.5, y, 3, 4);
            ctx.fillRect(x + TILE / 2 - 1.5, y + TILE - 4, 3, 4);
          } else {
            // closed: an energy wall
            ctx.fillStyle = "rgba(34,211,238,0.30)";
            ctx.fillRect(x + 3, y, TILE - 6, TILE);
            ctx.fillStyle = "rgba(165,243,252,0.7)";
            const sweep = (o.t / 4) % TILE;
            ctx.fillRect(x + 3, y + sweep, TILE - 6, 2);
            ctx.fillStyle = "#22d3ee";
            ctx.fillRect(x + TILE / 2 - 1.5, y, 3, 4);
            ctx.fillRect(x + TILE / 2 - 1.5, y + TILE - 4, 3, 4);
          }
          break;
        }
        default:
          floor(x, y, v);
      }
    }
  }

  const plate = (p: { x: number; y: number }, lit: boolean) => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
    ctx.fillStyle = lit ? "#4ade80" : "#3a3e55";
    ctx.fill();
    ctx.strokeStyle = lit ? "#86efac" : "#4a4f63";
    ctx.lineWidth = 2;
    ctx.stroke();
  };
  plate(lv.pos.P, o.meTile === "P" || o.partnerTile === "P");
  plate(lv.pos.Q, o.meTile === "Q" || o.partnerTile === "Q");

  // lever + switch
  const lever = lv.pos.L;
  const held = o.meTile === "L" || o.partnerTile === "L";
  ctx.fillStyle = held ? "#facc15" : "#3a3e55";
  ctx.fillRect(lever.x - 3, lever.y - 10, 6, 20);
  ctx.beginPath();
  ctx.arc(lever.x, lever.y - 10, 5, 0, Math.PI * 2);
  ctx.fill();
  const sw = lv.pos.S;
  ctx.beginPath();
  ctx.arc(sw.x, sw.y, 7, 0, Math.PI * 2);
  ctx.fillStyle = o.doors & LATCH ? "#4ade80" : "#f87171";
  ctx.fill();

  // code panels — only the right player can read each one
  ctx.textAlign = "center";
  const panel = (p: { x: number; y: number }, mine: boolean) => {
    ctx.font = "bold 10px ui-monospace, monospace";
    ctx.fillStyle = "#14151d";
    ctx.fillRect(p.x - 23, p.y - 9, 46, 18);
    ctx.strokeStyle = mine ? "#4ade80" : "#3a3e55";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(p.x - 23, p.y - 9, 46, 18);
    ctx.fillStyle = mine ? "#4ade80" : "#565b73";
    ctx.fillText(mine ? o.seeCode.join(" ") : "· · · ·", p.x, p.y + 4);
  };
  panel(lv.pos.g, o.role === 0);
  panel(lv.pos.G, o.role === 1);
  ctx.font = "bold 11px ui-monospace, monospace";

  // keypads — each usable only by the player who CAN'T see its code
  const pad = (p: { x: number; y: number }, mine: boolean, solved: boolean) => {
    ctx.fillStyle = solved ? "#1f3d2b" : "#14151d";
    ctx.fillRect(p.x - 10, p.y - 10, 20, 20);
    ctx.strokeStyle = solved ? "#4ade80" : mine ? "#facc15" : "#3a3e55";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(p.x - 10, p.y - 10, 20, 20);
    ctx.fillStyle = solved ? "#4ade80" : "#565b73";
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 3; c++) ctx.fillRect(p.x - 6 + c * 5, p.y - 6 + r * 5, 3, 3);
    if (mine && !solved && o.buf) {
      ctx.fillStyle = "#facc15";
      ctx.fillText(o.buf.padEnd(4, "·"), p.x, p.y - 15);
    }
  };
  pad(lv.pos.k, o.role === 1, (o.doors & LOCK1) !== 0);
  pad(lv.pos.K, o.role === 0, (o.doors & LOCK2) !== 0);

  // key stations — pulse amber inside the window, green once solved
  const now = Date.now();
  const station = (p: { x: number; y: number }, ts: number, label: string) => {
    const fresh = ts > 0 && now - ts <= o.keyWindowMs;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 9, 0, Math.PI * 2);
    ctx.fillStyle = o.frozen
      ? "#4ade80"
      : fresh
        ? `hsl(45 95% ${55 + Math.sin(o.t / 90) * 12}%)`
        : "#3a3e55";
    ctx.fill();
    ctx.fillStyle = "#14151d";
    ctx.fillRect(p.x - 1.5, p.y - 5, 3, 10);
    ctx.fillStyle = "#9aa0b4";
    ctx.font = "bold 9px ui-monospace, monospace";
    ctx.fillText(label, p.x, p.y - 14);
  };
  station(lv.pos.A, o.keyA, "A");
  station(lv.pos.B, o.keyB, "B");
}

export const hueOf = (key: string) =>
  [...key].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 0);

export interface Bubble {
  text: string;
  until: number;
}

export function drawPlayer(
  ctx: CanvasRenderingContext2D,
  key: string,
  p: { x: number; y: number; facing: number; name: string },
  opts: { self?: boolean; chat?: Bubble },
) {
  const hue = hueOf(key);
  const { x, y } = p;
  ctx.beginPath();
  ctx.ellipse(x, y + 10, 8, 3, 0, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(0,0,0,0.25)";
  ctx.fill();
  ctx.beginPath();
  ctx.roundRect(x - 9, y - 12, 18, 22, 6);
  ctx.fillStyle = `hsl(${hue} 65% ${opts.self ? 62 : 52}%)`;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = opts.self ? "#ffffff" : `hsl(${hue} 50% 30%)`;
  ctx.stroke();

  const eyeDx = p.facing === 1 ? -3 : p.facing === 2 ? 3 : 0;
  ctx.fillStyle = "#20222d";
  if (p.facing !== 3) {
    ctx.fillRect(x - 4 + eyeDx, y - 6, 3, 4);
    ctx.fillRect(x + 2 + eyeDx, y - 6, 3, 4);
  }

  ctx.font = "bold 10px ui-monospace, monospace";
  ctx.textAlign = "center";
  const w = ctx.measureText(p.name).width;
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(x - w / 2 - 3, y - 27, w + 6, 12);
  ctx.fillStyle = "#fff";
  ctx.fillText(p.name, x, y - 18);

  if (opts.chat && opts.chat.until > Date.now()) {
    ctx.font = "11px system-ui, sans-serif";
    const bw = Math.min(180, ctx.measureText(opts.chat.text).width + 12);
    const bx = x - bw / 2;
    const by = y - 52;
    ctx.beginPath();
    ctx.roundRect(bx, by, bw, 18, 6);
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x - 4, by + 18);
    ctx.lineTo(x + 4, by + 18);
    ctx.lineTo(x, by + 24);
    ctx.fill();
    ctx.fillStyle = "#20222d";
    ctx.fillText(
      opts.chat.text.length > 30 ? opts.chat.text.slice(0, 29) + "…" : opts.chat.text,
      x,
      by + 13,
    );
  }
}
