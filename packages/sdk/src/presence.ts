import { PublicKey } from "@solana/web3.js";
import { Room } from "./room";

/** A player's latest presence as seen by `trackPresence`. */
export interface PresenceEntry<T> {
  player: PublicKey;
  data: T;
  seq: number;
  /** Local wall-clock time the update arrived. */
  updatedAt: number;
}

export interface TrackPresenceOptions<T> {
  /** Drop players not heard from for this long (default 5000ms). Presence
   *  slots stay onchain when a tab closes without leave(); this keeps ghosts
   *  out of the roster. */
  staleMs?: number;
  /** Staleness sweep interval (default 1000ms). */
  sweepMs?: number;
  onJoin?: (entry: PresenceEntry<T>) => void;
  onUpdate?: (entry: PresenceEntry<T>) => void;
  onLeave?: (player: PublicKey) => void;
}

export interface PresenceTracker<T> {
  /** Live roster keyed by player pubkey (base58). */
  readonly players: ReadonlyMap<string, PresenceEntry<T>>;
  stop(): void;
}

/**
 * Turn the raw presence stream into a player roster with join/leave
 * lifecycle — the `onPlayerJoin` / `player.onQuit` of solsocket:
 *
 *   const roster = trackPresence(room, {
 *     onJoin: ({ player }) => addAvatar(player),
 *     onUpdate: ({ player, data }) => moveAvatar(player, data),
 *     onLeave: (player) => removeAvatar(player),
 *   });
 */
export function trackPresence<T, M>(
  room: Room<T, M>,
  opts: TrackPresenceOptions<T> = {},
): PresenceTracker<T> {
  const staleMs = opts.staleMs ?? 5_000;
  const sweepMs = opts.sweepMs ?? 1_000;
  const players = new Map<string, PresenceEntry<T>>();

  const unsub = room.onPresence(({ player, data, seq }) => {
    const key = player.toBase58();
    const known = players.get(key);
    if (known && seq <= known.seq) return; // out-of-order delivery
    const entry = { player, data, seq, updatedAt: Date.now() };
    players.set(key, entry);
    if (known) opts.onUpdate?.(entry);
    else opts.onJoin?.(entry);
  });

  const sweep = setInterval(() => {
    const cutoff = Date.now() - staleMs;
    for (const [key, entry] of players) {
      if (entry.updatedAt < cutoff) {
        players.delete(key);
        opts.onLeave?.(entry.player);
      }
    }
  }, sweepMs);

  return {
    players,
    stop() {
      clearInterval(sweep);
      unsub();
    },
  };
}

export interface SmoothPresenceOptions {
  /** Render callback frequency (default 60/s). */
  hz?: number;
  /** Remote players render this far in the past so there is always a next
   *  sample to interpolate toward (default 120ms — comfortably above one
   *  broadcast interval at 10Hz plus delivery jitter). */
  delayMs?: number;
  /** Drop players not heard from for this long (default 5000ms). */
  staleMs?: number;
}

/**
 * Interpolated presence: broadcasts arrive at ~10Hz, your render loop runs at
 * 60fps — this bridges the gap. Numeric fields are linearly interpolated
 * between the two most recent samples (rendered `delayMs` in the past, the
 * standard entity-interpolation trick); other fields snap to the latest.
 *
 *   const stop = smoothPresence(room, (players) => {
 *     for (const [key, p] of players) drawAvatar(key, p.data.x, p.data.y);
 *   });
 */
export function smoothPresence<T extends Record<string, unknown>, M>(
  room: Room<T, M>,
  render: (players: ReadonlyMap<string, PresenceEntry<T>>) => void,
  opts: SmoothPresenceOptions = {},
): () => void {
  const hz = opts.hz ?? 60;
  const delayMs = opts.delayMs ?? 120;
  const staleMs = opts.staleMs ?? 5_000;

  type Sample = { data: T; at: number };
  const buffers = new Map<string, { player: PublicKey; seq: number; a?: Sample; b: Sample }>();

  const unsub = room.onPresence(({ player, data, seq }) => {
    const key = player.toBase58();
    const buf = buffers.get(key);
    if (buf && seq <= buf.seq) return;
    const sample = { data, at: Date.now() };
    if (buf) {
      buffers.set(key, { player, seq, a: buf.b, b: sample });
    } else {
      buffers.set(key, { player, seq, b: sample });
    }
  });

  const lerpFields = (a: T, b: T, t: number): T => {
    const out: Record<string, unknown> = { ...b };
    for (const k of Object.keys(b)) {
      const va = a[k];
      const vb = b[k];
      if (typeof va === "number" && typeof vb === "number") {
        out[k] = va + (vb - va) * t;
      }
    }
    return out as T;
  };

  const timer = setInterval(() => {
    const now = Date.now();
    const renderAt = now - delayMs;
    const view = new Map<string, PresenceEntry<T>>();
    for (const [key, buf] of buffers) {
      if (now - buf.b.at > staleMs) {
        buffers.delete(key);
        continue;
      }
      let data: T;
      if (buf.a && buf.b.at > buf.a.at && renderAt < buf.b.at) {
        const t = Math.max(0, (renderAt - buf.a.at) / (buf.b.at - buf.a.at));
        data = lerpFields(buf.a.data, buf.b.data, Math.min(1, t));
      } else {
        data = buf.b.data;
      }
      view.set(key, { player: buf.player, data, seq: buf.seq, updatedAt: buf.b.at });
    }
    render(view);
  }, Math.max(1, Math.round(1000 / hz)));

  return () => {
    clearInterval(timer);
    unsub();
  };
}
