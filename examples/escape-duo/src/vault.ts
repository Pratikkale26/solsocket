import { PublicKey } from "@solana/web3.js";

/** The Vault — four chambers, each puzzle solvable only by two players.
 *  Legend: `#` wall  `.` floor  `1` plate door  `2` code door  `3` held gate
 *  `4` vault door  `P`/`Q` pressure plates  `g`/`G` code panels  `k`/`K`
 *  keypads  `L` lever  `S` gate switch  `A`/`B` key stations */
export const TILE = 24;

const LAYOUT = [
  "############################",
  "#......#......#.....#......#",
  "#..P...#..g...#.....#..A...#",
  "#......#......#..L..#......#",
  "#......1..k...2.....3.S....#",
  "#......1......2.....3......4",
  "#......1......2.....3......4",
  "#......#..K...#.....#......#",
  "#..Q...#......#.....#..B...#",
  "#......#..G...#.....#......#",
  "#......#......#.....#......#",
  "############################",
];

export const ROWS = LAYOUT.length;
export const COLS = LAYOUT[0].length;
export const WIDTH = COLS * TILE;
export const HEIGHT = ROWS * TILE;

for (const row of LAYOUT) {
  if (row.length !== COLS) throw new Error(`map row length ${row.length} !== ${COLS}`);
}

export const SPAWN = { x: 3.5 * TILE, y: 5.5 * TILE };

/** Shared vault state — one binary struct the whole room agrees on. */
export type VaultState = {
  doors: number; // progress bitfield
  keyA: number; // ms timestamp of key A's last turn
  keyB: number;
  start: number; // ms timestamp set when the run begins (door 1 opens)
};
export const DOOR1 = 1; // both plates pressed at once
export const LOCK1 = 2; // keypad k solved
export const LOCK2 = 4; // keypad K solved
export const LATCH = 8; // gate switch hit — gate 3 stays open
export const KEY_WINDOW_MS = 2_000;

export const escaped = (s: VaultState) =>
  s.keyA > 0 && s.keyB > 0 && Math.abs(s.keyA - s.keyB) <= KEY_WINDOW_MS;

export function tileAt(col: number, row: number): string {
  if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return "#";
  return LAYOUT[row][col];
}

export const tileUnder = (x: number, y: number) =>
  tileAt(Math.floor(x / TILE), Math.floor(y / TILE));

/** Center of the (unique) tile carrying a legend character. */
function findTile(ch: string) {
  for (let r = 0; r < ROWS; r++) {
    const c = LAYOUT[r].indexOf(ch);
    if (c >= 0) return { x: c * TILE + TILE / 2, y: r * TILE + TILE / 2 };
  }
  throw new Error(`map has no '${ch}' tile`);
}
export const POS = Object.fromEntries(
  [..."PQgGkKLSAB"].map((ch) => [ch, findTile(ch)]),
) as Record<string, { x: number; y: number }>;

export function walkable(
  x: number,
  y: number,
  doors: number,
  leverHeld: boolean,
  half = 8,
): boolean {
  for (const [dx, dy] of [
    [-half, -half],
    [half, -half],
    [-half, half],
    [half, half],
  ] as const) {
    const t = tileAt(Math.floor((x + dx) / TILE), Math.floor((y + dy) / TILE));
    if (t === "#" || t === "4") return false;
    if (t === "1" && !(doors & DOOR1)) return false;
    if (t === "2" && !(doors & LOCK1 && doors & LOCK2)) return false;
    if (t === "3" && !(doors & LATCH) && !leverHeld) return false;
  }
  return true;
}

export function near(ax: number, ay: number, bx: number, by: number, tiles: number): boolean {
  const r = tiles * TILE;
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy <= r * r;
}

/** The two 4-digit codes, derived from the room address — same for every
 *  client, different for every vault. Each player can only SEE the code
 *  their partner must type: the relay is the puzzle. */
export function codesFor(room: PublicKey): { code1: number[]; code2: number[] } {
  const b = room.toBytes();
  return {
    code1: [...b.slice(0, 4)].map((n) => n % 10),
    code2: [...b.slice(4, 8)].map((n) => n % 10),
  };
}

export interface DrawOpts {
  t: number;
  doors: number;
  escaped: boolean;
  role: number; // 0 or 1 — decides which panel/keypad is "yours"
  seeCode: number[]; // the code THIS viewer can read off their panel
  buf: string; // digits typed so far on the viewer's keypad
  meTile: string;
  partnerTile: string;
  keyA: number;
  keyB: number;
}

const shade = (c: number, r: number) => (c * 7 + r * 13) % 3;

export function drawVault(ctx: CanvasRenderingContext2D, o: DrawOpts) {
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
      const ch = tileAt(c, r);
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
          ctx.fillStyle = o.escaped ? "#141520" : "#8a6d1f";
          ctx.fillRect(x, y, TILE, TILE);
          if (!o.escaped) {
            ctx.strokeStyle = "#d4a017";
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(x + TILE / 2, y + TILE / 2, 7, 0, Math.PI * 2);
            ctx.stroke();
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
  plate(POS.P, o.meTile === "P" || o.partnerTile === "P");
  plate(POS.Q, o.meTile === "Q" || o.partnerTile === "Q");

  // lever + switch
  const lever = POS.L;
  const held = o.meTile === "L" || o.partnerTile === "L";
  ctx.fillStyle = held ? "#facc15" : "#3a3e55";
  ctx.fillRect(lever.x - 3, lever.y - 10, 6, 20);
  ctx.beginPath();
  ctx.arc(lever.x, lever.y - 10, 5, 0, Math.PI * 2);
  ctx.fill();
  const sw = POS.S;
  ctx.beginPath();
  ctx.arc(sw.x, sw.y, 7, 0, Math.PI * 2);
  ctx.fillStyle = o.doors & LATCH ? "#4ade80" : "#f87171";
  ctx.fill();

  // code panels — only the right player can read each one
  ctx.font = "bold 11px ui-monospace, monospace";
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
  panel(POS.g, o.role === 0);
  panel(POS.G, o.role === 1);
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
  pad(POS.k, o.role === 1, (o.doors & LOCK1) !== 0);
  pad(POS.K, o.role === 0, (o.doors & LOCK2) !== 0);

  // key stations — pulse amber inside the 2s window, green once escaped
  const now = Date.now();
  const station = (p: { x: number; y: number }, ts: number, label: string) => {
    const fresh = ts > 0 && now - ts <= KEY_WINDOW_MS;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 9, 0, Math.PI * 2);
    ctx.fillStyle = o.escaped
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
  station(POS.A, o.keyA, "A");
  station(POS.B, o.keyB, "B");
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
