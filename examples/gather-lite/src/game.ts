import { TILE } from "./map";

/** The 23-byte presence payload every avatar broadcasts (vs ~70 as JSON). */
export type Avatar = {
  x: number;
  y: number;
  facing: number; // 0 down, 1 left, 2 right, 3 up
  emote: number; // reserved
  name: string;
};

export type ChatMsg = { text: string };
export type EmoteMsg = { kind: number };
export type WorldState = { door: boolean };

export const EMOTES = ["👋", "❤️", "😂", "🎉"];
export const PROXIMITY_TILES = 4;

export const hueOf = (key: string) =>
  [...key].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 0);

export interface Overlay {
  text: string;
  until: number;
}

export function drawAvatar(
  ctx: CanvasRenderingContext2D,
  key: string,
  a: Avatar,
  opts: { self?: boolean; nearby?: boolean; chat?: Overlay; emote?: Overlay },
) {
  const hue = hueOf(key);
  const { x, y } = a;

  if (opts.nearby && !opts.self) {
    ctx.beginPath();
    ctx.arc(x, y + 2, TILE * 0.85, 0, Math.PI * 2);
    ctx.fillStyle = `hsl(${hue} 80% 60% / 0.18)`;
    ctx.fill();
  }

  // shadow + body
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

  // eyes follow facing
  const eyeDx = a.facing === 1 ? -3 : a.facing === 2 ? 3 : 0;
  const eyeDy = a.facing === 3 ? -2 : 0;
  ctx.fillStyle = "#20222d";
  if (a.facing !== 3) {
    ctx.fillRect(x - 4 + eyeDx, y - 6 + eyeDy, 3, 4);
    ctx.fillRect(x + 2 + eyeDx, y - 6 + eyeDy, 3, 4);
  }

  // name
  ctx.font = "bold 10px ui-monospace, monospace";
  ctx.textAlign = "center";
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(x - ctx.measureText(a.name).width / 2 - 3, y - 27, ctx.measureText(a.name).width + 6, 12);
  ctx.fillStyle = "#fff";
  ctx.fillText(a.name, x, y - 18);

  const now = Date.now();
  if (opts.emote && opts.emote.until > now) {
    ctx.font = "16px sans-serif";
    const rise = Math.min(1, (2500 - (opts.emote.until - now)) / 400) * 8;
    ctx.fillText(opts.emote.text, x, y - 34 - rise);
  }

  if (opts.chat && opts.chat.until > now) {
    if (opts.nearby || opts.self) {
      ctx.font = "11px system-ui, sans-serif";
      const w = Math.min(180, ctx.measureText(opts.chat.text).width + 12);
      const bx = x - w / 2;
      const by = y - 52;
      ctx.beginPath();
      ctx.roundRect(bx, by, w, 18, 6);
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
    } else {
      // Too far to "hear" — proximity chat is the point. Hint that they said something.
      ctx.font = "12px sans-serif";
      ctx.fillText("💬", x + 14, y - 24);
    }
  }
}
