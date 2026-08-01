/** Hand-coded tile world. Legend:
 *  `#` wall  `.` grass  `,` plaza path  `~` water  `=` house floor
 *  `D` the shared door (walkable only while the room's `door` state is open)
 */
export const TILE = 24;

const LAYOUT = [
  "##############################",
  "#..............######........#",
  "#..~~~.........#====#........#",
  "#.~~~~~........#====#....,,..#",
  "#..~~~.........#====#....,,..#",
  "#..............##==##........#",
  "#............................#",
  "#.....,,,,,,,,,,,,,,,,,......#",
  "#.....,...............,......#",
  "#.....,...............,......#",
  "#.....,,,,,,,,,,,,,,,,,......#",
  "#............................#",
  "#...#####D#####..............#",
  "#...#=========#......~~~.....#",
  "#...#=========#.....~~~~~....#",
  "#...#=========#......~~~.....#",
  "#...###########..............#",
  "#............................#",
  "#............................#",
  "##############################",
];

export const ROWS = LAYOUT.length;
export const COLS = LAYOUT[0].length;
export const WIDTH = COLS * TILE;
export const HEIGHT = ROWS * TILE;

for (const row of LAYOUT) {
  if (row.length !== COLS) throw new Error(`map row length ${row.length} !== ${COLS}`);
}

export function tileAt(col: number, row: number): string {
  if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return "#";
  return LAYOUT[row][col];
}

/** Can a player's bounding box occupy pixel position (x, y)? */
export function walkable(x: number, y: number, doorOpen: boolean, half = 8): boolean {
  for (const [dx, dy] of [
    [-half, -half],
    [half, -half],
    [-half, half],
    [half, half],
  ] as const) {
    const t = tileAt(Math.floor((x + dx) / TILE), Math.floor((y + dy) / TILE));
    if (t === "#" || t === "~") return false;
    if (t === "D" && !doorOpen) return false;
  }
  return true;
}

/** Squared-distance check used for proximity chat and the door hotspot. */
export function near(ax: number, ay: number, bx: number, by: number, tiles: number): boolean {
  const r = tiles * TILE;
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy <= r * r;
}

/** Center of the shared door tile. */
export const DOOR = (() => {
  for (let r = 0; r < ROWS; r++) {
    const c = LAYOUT[r].indexOf("D");
    if (c >= 0) return { x: c * TILE + TILE / 2, y: r * TILE + TILE / 2 };
  }
  throw new Error("map has no door tile");
})();

export const SPAWN = { x: 15 * TILE, y: 9 * TILE };

const shade = (col: number, row: number) => (col * 7 + row * 13) % 3;

export function drawWorld(ctx: CanvasRenderingContext2D, doorOpen: boolean, t: number) {
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const x = c * TILE;
      const y = r * TILE;
      const v = shade(c, r);
      switch (tileAt(c, r)) {
        case "#": {
          ctx.fillStyle = ["#464657", "#4c4c5e", "#515164"][v];
          ctx.fillRect(x, y, TILE, TILE);
          ctx.fillStyle = "#3a3a49";
          ctx.fillRect(x, y + TILE - 4, TILE, 4);
          break;
        }
        case ".": {
          ctx.fillStyle = ["#6fae57", "#74b35c", "#6aa953"][v];
          ctx.fillRect(x, y, TILE, TILE);
          if (v === 2) {
            ctx.fillStyle = "#7fbd66";
            ctx.fillRect(x + 6, y + 8, 2, 2);
            ctx.fillRect(x + 15, y + 16, 2, 2);
          }
          break;
        }
        case ",": {
          ctx.fillStyle = ["#d8c9a3", "#dccfab", "#d3c39a"][v];
          ctx.fillRect(x, y, TILE, TILE);
          break;
        }
        case "~": {
          const wave = Math.sin(t / 500 + c * 0.9 + r * 1.3) * 6;
          ctx.fillStyle = `hsl(210 70% ${46 + wave / 2}%)`;
          ctx.fillRect(x, y, TILE, TILE);
          break;
        }
        case "=": {
          ctx.fillStyle = ["#b58863", "#bb8f6a", "#b0825d"][v];
          ctx.fillRect(x, y, TILE, TILE);
          break;
        }
        case "D": {
          if (doorOpen) {
            ctx.fillStyle = "#b58863";
            ctx.fillRect(x, y, TILE, TILE);
            ctx.strokeStyle = "#7a5230";
            ctx.strokeRect(x + 1.5, y + 1.5, TILE - 3, TILE - 3);
          } else {
            ctx.fillStyle = "#7a5230";
            ctx.fillRect(x, y, TILE, TILE);
            ctx.fillStyle = "#8d6239";
            ctx.fillRect(x + 3, y + 2, TILE - 6, TILE - 4);
            ctx.fillStyle = "#f5d76e";
            ctx.fillRect(x + TILE - 8, y + TILE / 2 - 1, 3, 3);
          }
          break;
        }
      }
    }
  }
}
