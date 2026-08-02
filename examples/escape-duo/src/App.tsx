import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  PresenceEntry,
  Room,
  RoomListing,
  SolSocket,
  smoothPresence,
  structCodec,
} from "solsocket";
import {
  Bubble,
  CHARGE_MS,
  DOOR1,
  LATCH,
  LEVELS,
  LOCK1,
  LOCK2,
  HEIGHT,
  VALVE_WINDOW_MS,
  VaultState,
  WIDTH,
  codesFor,
  deadlyTile,
  drawPlayer,
  drawVault,
  isFinal,
  levelOf,
  near,
  pulseOpen,
  solvedKeys,
  tileUnder,
  walkable,
} from "./vault";
import { isMuted, setMuted, sfx } from "./sound";
import { loadBurnerWallet, requestAirdrop } from "./wallet";

const wallet = loadBurnerWallet();
const params = new URLSearchParams(location.search);
const cluster = params.get("cluster") === "local" ? ("local" as const) : ("devnet" as const);
const REGIONS = ["asia", "eu", "us"] as const;
const region =
  cluster === "devnet" ? REGIONS.find((r) => r === params.get("region")) : undefined;

type Player = { x: number; y: number; facing: number; carry: number; name: string };
type ChatMsg = { text: string };
type Vault = Room<VaultState, Player, ChatMsg>;

let joinTarget = params.get("room");
/** ?watch=1 — spectate: no join tx, no fees, no funded wallet needed. */
const watchMode = params.get("watch") === "1" && joinTarget !== null;

/* ──────────────────────────────────────────────────────────────────────────
 * The realtime integration: binary presence for the two players, shared
 * vault state for the puzzles, events for chat — all zero-fee onchain
 * transactions on a MagicBlock ephemeral rollup.
 * ────────────────────────────────────────────────────────────────────────── */
const playerCodec = structCodec<Player>([
  ["x", "u16"],
  ["y", "u16"],
  ["facing", "u8"],
  ["carry", "u8"],
  ["name", "string"],
]);
const vaultCodec = structCodec<VaultState>([
  ["level", "u8"],
  ["doors", "u8"],
  ["keyA", "f64"],
  ["keyB", "f64"],
  ["start", "f64"],
  ["run", "f64"],
]);
const FRESH_VAULT: VaultState = { level: 0, doors: 0, keyA: 0, keyB: 0, start: 0, run: 0 };

async function goLive(): Promise<Vault> {
  const sock = SolSocket.connect({ wallet, cluster, region });
  const opts = { codec: vaultCodec, presenceCodec: playerCodec };
  const room = watchMode
    ? await sock.spectate<VaultState, Player, ChatMsg>(new PublicKey(joinTarget!), opts)
    : joinTarget
      ? await sock.joinRoom<VaultState, Player, ChatMsg>(new PublicKey(joinTarget), opts)
      : await sock.createRoom<VaultState, Player, ChatMsg>({
          ...opts,
          maxPlayers: 2,
          initialState: FRESH_VAULT,
        });
  const suffix =
    (cluster === "local" ? "&cluster=local" : "") +
    (region ? `&region=${region}` : "") +
    (watchMode ? "&watch=1" : "");
  history.replaceState(null, "", `?room=${room.address.toBase58()}${suffix}`);
  return room;
}
/* ────────────────────────────────────────────────────────────────────────── */

function loadName(): string {
  return (
    localStorage.getItem("solsocket-escape:name") ??
    `anon-${wallet.publicKey.toBase58().slice(0, 4)}`
  );
}

const fmtTime = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export default function App() {
  const [phase, setPhase] = useState<"funding" | "connecting" | "live" | "error">(
    "funding",
  );
  const [error, setError] = useState("");
  const [balance, setBalance] = useState<number | null>(null);
  const [name, setName] = useState(loadName);
  const [doors, setDoors] = useState(0);
  const [level, setLevel] = useState(0);
  const [cleared, setCleared] = useState(false); // level solved, more to go
  const [out, setOut] = useState(false); // final level solved — escaped!
  const [online, setOnline] = useState(1);
  const [clock, setClock] = useState("");
  const [txCount, setTxCount] = useState(0);
  const [echo, setEcho] = useState<number | null>(null);
  const [chatDraft, setChatDraft] = useState("");
  const [showHint, setShowHint] = useState(true);
  const [board, setBoard] = useState<{ addr: string; time: number }[]>([]);
  const [live, setLive] = useState<RoomListing[]>([]);
  const [mute, setMute] = useState(isMuted());

  const roomRef = useRef<Vault | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chatInputRef = useRef<HTMLInputElement>(null);
  const remotes = useRef<ReadonlyMap<string, PresenceEntry<Player>>>(new Map());
  const chats = useRef(new Map<string, Bubble>());
  const vault = useRef<VaultState>({ ...FRESH_VAULT });
  const buf = useRef("");
  const myKeyAt = useRef(0);
  const sent = useRef(0);
  const sentAt = useRef(0);
  const flash = useRef<{ until: number } | null>(null);
  const carryRef = useRef(false); // fuel mech: holding my cell right now
  const valveRef = useRef({ half: 0, at: 0 }); // valves mech: pair 1 latched?
  const chargeRef = useRef({ start: 0, lastBoth: 0 }); // charge mech: hold timer
  const sndPrev = useRef({ doors: 0, cleared: false, out: false, keyA: 0, keyB: 0 });

  const selfKey = wallet.publicKey.toBase58();
  const roleRef = useRef(0);

  const partnerKey = () =>
    [...remotes.current.keys()].find((k) => k !== selfKey) ?? null;
  /** Structural roles, stamped per room: the creator is 0 (key A), the
   *  joiner is 1 (key B). Stored so a refresh can't flip it — and the two
   *  clients can never disagree. */
  const myRole = () => roleRef.current;

  const refreshBalance = useCallback(async () => {
    const sock = SolSocket.connect({ wallet, cluster });
    const lamports = await sock.base.getBalance(wallet.publicKey);
    setBalance(lamports / LAMPORTS_PER_SOL);
    return lamports;
  }, []);

  useEffect(() => {
    void refreshBalance();
    // Leaderboard + live vaults: every vault is a room on the rollup, and
    // peekState reads any room's state without joining — no server anywhere.
    const sock = SolSocket.connect({ wallet, cluster, region });
    sock
      .listRooms()
      .then(async (rooms) => {
        setLive(rooms.filter((r) => r.maxPlayers === 2 && r.players > 0).slice(0, 4));
        const peeks = await Promise.all(
          rooms.slice(0, 24).map(async (r) => ({
            addr: r.address.toBase58(),
            s: await sock.peekState<VaultState>(r.address, vaultCodec).catch(() => null),
          })),
        );
        const plausibleTs = (t: number) => t > 1.5e12 && t < 4e12;
        setBoard(
          peeks
            .flatMap(({ addr, s }) => {
              if (!s) return [];
              const v = s.state;
              // Other apps' rooms share the program — filter to states that
              // genuinely look like finished vault runs.
              if (!isFinal(v) || v.level >= LEVELS.length + 1 || !solvedKeys(v)) return [];
              if (!plausibleTs(v.run) || !plausibleTs(v.keyA)) return [];
              const time = Math.max(v.keyA, v.keyB) - v.run;
              return time > 10_000 ? [{ addr, time }] : [];
            })
            .sort((a, b) => a.time - b.time)
            .slice(0, 5),
        );
      })
      .catch(() => {});
  }, [refreshBalance]);

  const syncUi = () => {
    const v = vault.current;
    setDoors(v.doors);
    setLevel(v.level);
    const solved = solvedKeys(v);
    const nowOut = solved && isFinal(v);
    const nowCleared = solved && !isFinal(v);
    setOut(nowOut);
    setCleared(nowCleared);
    // sound triggers: fire once per state transition, whoever caused it
    const p = sndPrev.current;
    if (v.doors & DOOR1 && !(p.doors & DOOR1)) sfx.door();
    if (v.doors & LOCK1 && !(p.doors & LOCK1)) sfx.door();
    if (v.doors & LOCK2 && !(p.doors & LOCK2)) sfx.door();
    if (v.doors & LATCH && !(p.doors & LATCH)) sfx.latch();
    if ((v.keyA && v.keyA !== p.keyA) || (v.keyB && v.keyB !== p.keyB)) sfx.turn();
    if (nowCleared && !p.cleared) sfx.clear();
    if (nowOut && !p.out) sfx.escape();
    sndPrev.current = {
      doors: v.doors,
      cleared: nowCleared,
      out: nowOut,
      keyA: v.keyA,
      keyB: v.keyB,
    };
  };

  /** Send the vault state, retrying through transient ER failures — a
   *  silently dropped write would leave the two players in different
   *  realities, which is worse than a late one. */
  const pushState = (tries = 5) => {
    if (watchMode) return; // spectators hold no presence slot — read-only
    sent.current += 1;
    roomRef.current?.setState({ ...vault.current }).catch(() => {
      if (tries > 1) setTimeout(() => pushState(tries - 1), 1_500);
    });
  };

  /** Every state write merges over the latest known state — and updates the
   *  local mirror optimistically so the UI never waits on the round trip. */
  const writeState = (patch: Partial<VaultState>) => {
    vault.current = { ...vault.current, ...patch };
    syncUi();
    pushState();
  };

  const applyState = (s: VaultState) => {
    const cur = vault.current;
    if (s.level > cur.level) {
      // Partner advanced the run — follow them into the next level.
      vault.current = { ...s };
      buf.current = "";
      myKeyAt.current = 0;
      syncUi();
      return;
    }
    if (s.level < cur.level) {
      // The chain hasn't caught up to our advance yet — push it again.
      pushState();
      return;
    }
    // Same level: never let a stale/raced write regress local progress bits...
    const doorsMerged = s.doors | cur.doors;
    const chainMissedBits = doorsMerged !== s.doors;
    vault.current = { ...s, doors: doorsMerged };
    // ...and if a race wiped our own key-turn, restore it.
    if (myKeyAt.current > 0 && Date.now() - myKeyAt.current < 10_000) {
      const iAmA = myRole() === 0;
      if ((iAmA ? vault.current.keyA : vault.current.keyB) === 0) {
        writeState(iAmA ? { keyA: myKeyAt.current } : { keyB: myKeyAt.current });
        return;
      }
    }
    // If the chain lost progress bits we hold (a raced overwrite), write the
    // merged truth back so both clients reconverge.
    if (chainMissedBits) pushState();
    syncUi();
  };

  /** Either player advances the run once a level is solved. Idempotent —
   *  a double click or a simultaneous click from both players is harmless. */
  const advance = () => {
    if (watchMode) return; // players decide when to advance, not the audience
    const v = vault.current;
    if (!solvedKeys(v) || isFinal(v)) return;
    buf.current = "";
    myKeyAt.current = 0;
    writeState({ level: v.level + 1, doors: 0, keyA: 0, keyB: 0, start: 0, run: v.run });
  };

  const enter = async () => {
    localStorage.setItem("solsocket-escape:name", name);
    setPhase("connecting");
    try {
      const room = await goLive();
      roomRef.current = room;
      if (watchMode) {
        roleRef.current = -1; // spectator: no panel, no keypad, no key
      } else {
        const roleKey = `solsocket-escape:role:${room.address.toBase58()}`;
        const stored = localStorage.getItem(roleKey);
        roleRef.current = stored !== null ? Number(stored) : joinTarget ? 1 : 0;
        localStorage.setItem(roleKey, String(roleRef.current));
      }
      room.onStateChange(({ state }) => applyState(state));
      const first = await room.getState();
      if (first) applyState(first.state);
      room.onMessage("chat", ({ player, data }) => {
        if (player.toBase58() !== selfKey) sfx.chat();
        chats.current.set(player.toBase58(), {
          text: (data as ChatMsg).text,
          until: Date.now() + 5_000,
        });
      });
      room.onPresence(({ player }) => {
        if (player.toBase58() === selfKey && sentAt.current) {
          setEcho(Date.now() - sentAt.current);
        }
      });
      smoothPresence(room, (players) => {
        remotes.current = players;
      });
      setPhase("live");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  };

  // Game loop: local prediction, 10Hz presence broadcast, 60fps render.
  useEffect(() => {
    if (phase !== "live") return;
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    const keys = new Set<string>();
    let curLevel = vault.current.level;
    const me = { x: levelOf(vault.current).spawn.x, y: levelOf(vault.current).spawn.y, facing: 0 };
    let lastSend = 0;
    let lastMoved = 0;
    let lastLatch = 0;
    let lastTile = "";
    let raf = 0;
    let last = performance.now();

    const typing = () => document.activeElement === chatInputRef.current;
    const room = () => roomRef.current;

    const partner = () => {
      const p = partnerKey();
      return p ? remotes.current.get(p) : undefined;
    };

    const broadcast = (force = false) => {
      if (watchMode) return; // spectators are invisible — nothing to publish
      const now = Date.now();
      if (!force && now - lastSend < 100) return;
      lastSend = now;
      sentAt.current = now;
      sent.current += 1;
      void room()?.broadcast({
        x: Math.round(me.x),
        y: Math.round(me.y),
        facing: me.facing,
        carry: carryRef.current ? 1 : 0,
        name,
      });
    };

    const lv = () => levelOf(vault.current);
    const myPad = () => (myRole() === 0 ? lv().pos.K : lv().pos.k);
    const enterDigit = (d: string) => {
      buf.current = (buf.current + d).slice(0, 4);
      if (buf.current.length < 4) return;
      const codes = codesFor(room()!.address, vault.current.level);
      const want = (myRole() === 0 ? codes.code2 : codes.code1).join("");
      if (buf.current === want) {
        writeState({ doors: vault.current.doors | (myRole() === 0 ? LOCK2 : LOCK1) });
      } else {
        sfx.wrong();
        chats.current.set(selfKey, { text: "✗ wrong code", until: Date.now() + 1_500 });
      }
      buf.current = "";
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (watchMode) return; // spectators only watch
      if (e.key === "Enter") {
        chatInputRef.current?.focus();
        return;
      }
      if (typing()) return;
      setShowHint(false);
      // Physical key codes: immune to layout, CapsLock, and IME surprises.
      keys.add(e.code);

      if (e.key === "Backspace") {
        buf.current = "";
        return;
      }
      if (/^[0-9]$/.test(e.key)) {
        if (lv().mech.locks !== "codes") return;
        const pad = myPad();
        const theirs = myRole() === 0 ? lv().pos.k : lv().pos.K;
        if (near(me.x, me.y, pad.x, pad.y, 1.6)) {
          sfx.key();
          enterDigit(e.key);
        } else if (near(me.x, me.y, theirs.x, theirs.y, 1.6)) {
          chats.current.set(selfKey, {
            text: "partner's keypad — yours has the yellow border",
            until: Date.now() + 2_000,
          });
        }
        return;
      }
      if (e.code !== "KeyE") return;
      const L = lv();
      const mech = L.mech;
      const d = vault.current.doors;
      // stage 2: the fuel run — grab your cell, slot it into your socket
      if (mech.locks === "fuel") {
        const mine = myRole() === 0;
        const cradle = mine ? L.pos.u : L.pos.U;
        const socket = mine ? L.pos.o : L.pos.O;
        const bit = mine ? LOCK2 : LOCK1;
        if (!carryRef.current && !(d & bit) && near(me.x, me.y, cradle.x, cradle.y, 1.4)) {
          carryRef.current = true;
          sfx.key();
          broadcast(true);
          return;
        }
        if (carryRef.current && near(me.x, me.y, socket.x, socket.y, 1.4)) {
          carryRef.current = false;
          sfx.latch();
          broadcast(true);
          writeState({ doors: d | bit });
          return;
        }
      }
      // stage 2: the breakers behind each other's lever gates
      if (mech.locks === "levers") {
        if (!(d & LOCK2) && near(me.x, me.y, L.pos.a.x, L.pos.a.y, 1.3)) {
          writeState({ doors: d | LOCK2 });
          return;
        }
        if (!(d & LOCK1) && near(me.x, me.y, L.pos.b.x, L.pos.b.y, 1.3)) {
          writeState({ doors: d | LOCK1 });
          return;
        }
      }
      // stage 3 switch (the gate latch / the vent purge share the S char)
      if (
        mech.latch !== "charge" &&
        near(me.x, me.y, L.pos.S.x, L.pos.S.y, 1.3) &&
        !(d & LATCH)
      ) {
        writeState({ doors: d | LATCH });
      } else if (myRole() === 0 && near(me.x, me.y, L.pos.A.x, L.pos.A.y, 1.3)) {
        myKeyAt.current = Date.now();
        writeState({ keyA: myKeyAt.current });
      } else if (myRole() === 1 && near(me.x, me.y, L.pos.B.x, L.pos.B.y, 1.3)) {
        myKeyAt.current = Date.now();
        writeState({ keyB: myKeyAt.current });
      }
    };
    const onKeyUp = (e: KeyboardEvent) => keys.delete(e.code);
    // Alt-tabbing away eats keyup events — clear held keys so nobody walks
    // into a wall forever.
    const onBlur = () => keys.clear();
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);

    const counters = setInterval(() => {
      setTxCount(sent.current);
      const others = [...remotes.current.keys()].filter((k) => k !== selfKey).length;
      setOnline(watchMode ? others : 1 + others);
      const v = vault.current;
      if (v.run > 0)
        setClock(
          fmtTime(
            (solvedKeys(v) && isFinal(v) ? Math.max(v.keyA, v.keyB) : Date.now()) - v.run,
          ),
        );
      if (Date.now() - lastSend > 2_500) broadcast(true);
      // countdown tick while your key is turned and the window is open
      if (
        !watchMode &&
        myKeyAt.current > 0 &&
        Date.now() - myKeyAt.current < levelOf(vault.current).keyWindowMs &&
        !solvedKeys(vault.current)
      )
        sfx.tick();
    }, 300);

    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const v = vault.current;
      const L = lv();

      // A level change moves both players back to the new level's spawn.
      if (v.level !== curLevel) {
        curLevel = v.level;
        me.x = L.spawn.x;
        me.y = L.spawn.y;
        buf.current = "";
        carryRef.current = false;
        valveRef.current = { half: 0, at: 0 };
        chargeRef.current = { start: 0, lastBoth: 0 };
        broadcast(true);
      }

      // Spectators have no avatar: judge everything purely from the players.
      const watchEntries = watchMode ? [...remotes.current.values()] : [];
      const tiles = watchEntries.map((e) => tileUnder(L, e.data.x, e.data.y));
      const p = partner();
      const pTile = watchMode ? (tiles[1] ?? "") : p ? tileUnder(L, p.data.x, p.data.y) : "";
      let myTile = watchMode ? (tiles[0] ?? "") : tileUnder(L, me.x, me.y);
      const pulse = pulseOpen(v.run, Date.now());
      const mech = L.mech;

      // Hazards: coolant, cracked glass, and the vent stream (deadly unless
      // your partner is freezing it from the vent plate — or it's purged).
      const ventSafe = (v.doors & LATCH) !== 0 || pTile === "V";
      if (!watchMode && !solvedKeys(v) && deadlyTile(myTile, ventSafe)) {
        me.x = L.spawn.x;
        me.y = L.spawn.y;
        myTile = tileUnder(L, me.x, me.y);
        carryRef.current = false; // the cell doesn't survive the trip
        flash.current = { until: Date.now() + 350 };
        sfx.hazard();
        broadcast(true);
      }
      if (!watchMode && "PQcdefVhH".includes(myTile) && lastTile !== myTile) sfx.plate();
      lastTile = myTile;

      const held = {
        lever: mech.latch === "gate" && (myTile === "L" || pTile === "L"),
        i: mech.locks === "levers" && (myTile === "i" || pTile === "i"),
        j: mech.locks === "levers" && (myTile === "j" || pTile === "j"),
      };
      const frozen = solvedKeys(v);

      if (!typing() && !frozen && !watchMode) {
        const speed = carryRef.current ? 95 : 130; // the cell is heavy
        let vx = 0;
        let vy = 0;
        if (keys.has("ArrowLeft") || keys.has("KeyA")) vx -= 1;
        if (keys.has("ArrowRight") || keys.has("KeyD")) vx += 1;
        if (keys.has("ArrowUp") || keys.has("KeyW")) vy -= 1;
        if (keys.has("ArrowDown") || keys.has("KeyS")) vy += 1;
        if (vx || vy) {
          const len = Math.hypot(vx, vy);
          const nx = me.x + (vx / len) * speed * dt;
          const ny = me.y + (vy / len) * speed * dt;
          if (walkable(L, nx, me.y, v.doors, held, pulse)) me.x = nx;
          if (walkable(L, me.x, ny, v.doors, held, pulse)) me.y = ny;
          me.facing = vy < 0 ? 3 : vx < 0 ? 1 : vx > 0 ? 2 : 0;
          lastMoved = Date.now();
        }
        if (Date.now() - lastMoved < 200) broadcast();
      }

      // Stage 1. Keep re-firing writes on a cooldown until the state sticks —
      // a single dropped write must never dead-lock the vault.
      const vr = valveRef.current;
      if (!(v.doors & DOOR1)) {
        if (mech.door1 === "valves") {
          // valves 1+2 together, then 3+4 inside the window
          const pair1 = (myTile === "c" && pTile === "d") || (myTile === "d" && pTile === "c");
          const pair2 = (myTile === "e" && pTile === "f") || (myTile === "f" && pTile === "e");
          if (vr.half === 1 && Date.now() - vr.at > VALVE_WINDOW_MS) {
            vr.half = 0;
            sfx.wrong();
          }
          if (vr.half === 0 && pair1) {
            vr.half = 1;
            vr.at = Date.now();
            sfx.plate();
          } else if (vr.half === 1 && pair2 && !watchMode && Date.now() - lastLatch > 1_500) {
            lastLatch = Date.now();
            writeState({
              doors: v.doors | DOOR1,
              start: v.start || Date.now(),
              run: v.run || Date.now(),
            });
          }
        } else if (
          // plates / bridge buttons: both pressed at the same moment
          !watchMode &&
          Date.now() - lastLatch > 1_500 &&
          ((myTile === "P" && pTile === "Q") || (myTile === "Q" && pTile === "P"))
        ) {
          lastLatch = Date.now();
          writeState({
            doors: v.doors | DOOR1,
            start: v.start || Date.now(),
            run: v.run || Date.now(),
          });
        }
      }

      // Stage 3 (The Core): hold both charge pads together, with a little
      // grace so a presence hiccup doesn't zero the timer.
      const cr = chargeRef.current;
      let chargeFrac = 0;
      if (mech.latch === "charge" && !(v.doors & LATCH)) {
        const both = (myTile === "h" && pTile === "H") || (myTile === "H" && pTile === "h");
        const nowMs = Date.now();
        if (both) {
          if (!cr.start) cr.start = nowMs;
          cr.lastBoth = nowMs;
        } else if (cr.start && nowMs - cr.lastBoth > 500) {
          cr.start = 0;
        }
        if (cr.start) chargeFrac = Math.min(1, (nowMs - cr.start) / CHARGE_MS);
        if (!watchMode && cr.start && nowMs - cr.start >= CHARGE_MS && nowMs - lastLatch > 1_500) {
          lastLatch = nowMs;
          writeState({ doors: v.doors | LATCH });
        }
      }

      // A half-typed code shouldn't linger: walking away clears the keypad.
      if (mech.locks === "codes" && buf.current && !near(me.x, me.y, myPad().x, myPad().y, 1.6))
        buf.current = "";

      const codes = codesFor(room()!.address, v.level);
      drawVault(ctx, L, {
        t: now,
        doors: v.doors,
        frozen,
        role: myRole(),
        seeCode: myRole() === 0 ? codes.code1 : codes.code2,
        buf: buf.current,
        meTile: myTile,
        partnerTile: pTile,
        keyA: v.keyA,
        keyB: v.keyB,
        keyWindowMs: L.keyWindowMs,
        pulseOn: pulse,
        valveHalf: vr.half,
        valveAt: vr.at,
        carryMe: watchMode ? !!watchEntries[0]?.data.carry : carryRef.current,
        carryPartner: watchMode ? !!watchEntries[1]?.data.carry : !!p?.data.carry,
        chargeFrac,
        ventOff: (v.doors & LATCH) !== 0 || myTile === "V" || pTile === "V",
        heldI: held.i,
        heldJ: held.j,
      });

      // contextual prompts
      ctx.font = "11px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      const winS = (L.keyWindowMs / 1000).toFixed(1).replace(/\.0$/, "");
      const nearPos = (key: string, tiles = 1.5) =>
        !watchMode && near(me.x, me.y, L.pos[key].x, L.pos[key].y, tiles);
      if (mech.door1 === "valves" && !(v.doors & DOOR1)) {
        for (const ch of ["c", "d", "e", "f"])
          if (nearPos(ch)) {
            ctx.fillText(
              vr.half === 0 ? "valves 1 + 2 together first" : "now 3 + 4 — before the ring runs out",
              L.pos[ch].x,
              L.pos[ch].y - 22,
            );
            break;
          }
      }
      if (mech.locks === "codes") {
        const pad = myPad();
        const theirPad = myRole() === 0 ? L.pos.k : L.pos.K;
        const padSolved = v.doors & (myRole() === 0 ? LOCK2 : LOCK1);
        if (!padSolved && near(me.x, me.y, pad.x, pad.y, 1.5))
          ctx.fillText("type the 4 digits your partner reads out", pad.x, pad.y - 24);
        if (near(me.x, me.y, theirPad.x, theirPad.y, 1.5))
          ctx.fillText("your partner's keypad — read them your panel", theirPad.x, theirPad.y - 24);
      }
      if (mech.locks === "fuel") {
        const mine = myRole() === 0;
        const cradle = mine ? L.pos.u : L.pos.U;
        const socket = mine ? L.pos.o : L.pos.O;
        const bit = mine ? LOCK2 : LOCK1;
        if (!(v.doors & bit) && !carryRef.current && near(me.x, me.y, cradle.x, cradle.y, 1.5))
          ctx.fillText("[E] grab your fuel cell", cradle.x, cradle.y - 22);
        if (carryRef.current && near(me.x, me.y, socket.x, socket.y, 1.5))
          ctx.fillText("[E] slot the cell", socket.x, socket.y - 22);
        else if (carryRef.current)
          ctx.fillText("to your yellow socket — coolant knocks it loose", me.x, me.y + 30);
      }
      if (mech.locks === "levers") {
        if (nearPos("i") || nearPos("j"))
          ctx.fillText("stand here — holds the FAR gate open for your partner", me.x, me.y - 34);
        if (!(v.doors & LOCK2) && nearPos("a"))
          ctx.fillText("[E] throw the breaker", L.pos.a.x, L.pos.a.y - 20);
        if (!(v.doors & LOCK1) && nearPos("b"))
          ctx.fillText("[E] throw the breaker", L.pos.b.x, L.pos.b.y - 20);
      }
      if (mech.latch === "gate" && !(v.doors & LATCH) && nearPos("S"))
        ctx.fillText("[E] lock the gate open", L.pos.S.x, L.pos.S.y - 20);
      if (mech.latch === "vent") {
        if (nearPos("V"))
          ctx.fillText("stand here — freezes the vent stream for your partner", L.pos.V.x, L.pos.V.y - 22);
        if (!(v.doors & LATCH) && nearPos("S"))
          ctx.fillText("[E] purge the vents for good", L.pos.S.x, L.pos.S.y - 20);
      }
      if (mech.latch === "charge" && !(v.doors & LATCH) && (nearPos("h") || nearPos("H")))
        ctx.fillText("hold BOTH pads together for 3s", L.pos.h.x, L.pos.h.y - 22);
      if (myRole() === 0 && nearPos("A"))
        ctx.fillText(`[E] turn key A — together, within ${winS}s`, L.pos.A.x, L.pos.A.y - 24);
      if (myRole() === 1 && nearPos("B"))
        ctx.fillText(`[E] turn key B — together, within ${winS}s`, L.pos.B.x, L.pos.B.y - 24);

      for (const [key, pp] of remotes.current) {
        if (key === selfKey) continue;
        drawPlayer(ctx, key, pp.data, {
          chat: chats.current.get(key),
          carry: !!pp.data.carry,
        });
      }
      if (!watchMode)
        drawPlayer(
          ctx,
          selfKey,
          { x: me.x, y: me.y, facing: me.facing, name },
          { self: true, chat: chats.current.get(selfKey), carry: carryRef.current },
        );

      // hazard hit: red flash fading out
      if (flash.current && flash.current.until > Date.now()) {
        const a = ((flash.current.until - Date.now()) / 350) * 0.35;
        ctx.fillStyle = `rgba(248,113,113,${a.toFixed(3)})`;
        ctx.fillRect(0, 0, WIDTH, HEIGHT);
      }

      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      clearInterval(counters);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, name]);

  const sendChat = (e: React.FormEvent) => {
    e.preventDefault();
    const text = chatDraft.trim();
    if (!text) {
      chatInputRef.current?.blur();
      return;
    }
    sent.current += 1;
    void roomRef.current?.emit("chat", { text });
    setChatDraft("");
    chatInputRef.current?.blur();
  };

  const airdrop = async () => {
    setError("");
    try {
      const sock = SolSocket.connect({ wallet, cluster });
      await requestAirdrop(sock.base, wallet);
      await refreshBalance();
    } catch {
      setError(
        "Airdrop failed (devnet faucet rate limit). Click the wallet chip to copy your burner address, send it ~0.01 devnet SOL, then reload.",
      );
    }
  };

  const room = roomRef.current;
  const curLv = LEVELS[Math.min(level, LEVELS.length - 1)];
  const lvName = curLv.name;
  const OBJ: Record<string, string> = {
    plates: "① one of you on each glowing plate — at the same moment",
    valves: "① valves 1+2 pressed together — then valves 3+4 within 6 seconds",
    bridge:
      "① the floor is cracked glass only your PARTNER can see — call out safe tiles, then stand on both buttons together",
    codes:
      "② read your green panel to your partner (Enter to chat) — type the code they read you on your yellow keypad (0-9)",
    fuel: "② grab your fuel cell with E and carry it to your yellow socket — coolant knocks it loose",
    levers: "② each breaker hides behind a gate only your partner's lever holds open — take turns",
    gate: "③ one stands on the lever to hold the gate — the other walks through and presses E on the switch",
    vent: "③ one stands on the vent plate to freeze the pink stream — the other crosses it and presses E on the purge switch",
    charge: "③ slip past the pulse wall and hold BOTH charge pads together for 3 seconds",
  };
  const objective = !room
    ? ""
    : watchMode
      ? `spectating${online ? "" : " — nobody inside right now"} · every move you see is a signed onchain transaction`
      : online < 2 && !(doors & DOOR1) && level === 0 && !out
        ? "waiting for your partner — this vault needs two"
      : out
        ? "you escaped — verify it on the explorer"
        : cleared
          ? "level cleared — hit next level when you're both ready"
          : !(doors & DOOR1)
            ? OBJ[curLv.mech.door1]
            : !(doors & LOCK1) || !(doors & LOCK2)
              ? OBJ[curLv.mech.locks]
              : !(doors & LATCH)
                ? OBJ[curLv.mech.latch]
                : `④ you are key ${myRole() === 0 ? "A" : "B"} — count down in chat, both press E together`;
  const STEP_LABEL: Record<string, string> = {
    plates: "plates",
    valves: "valves",
    bridge: "bridge",
    codes: "codes",
    fuel: "fuel",
    levers: "breakers",
    gate: "gate",
    vent: "purge",
    charge: "charge",
  };
  const steps: [string, boolean][] = [
    [STEP_LABEL[curLv.mech.door1], (doors & DOOR1) !== 0],
    [STEP_LABEL[curLv.mech.locks], (doors & LOCK1) !== 0 && (doors & LOCK2) !== 0],
    [STEP_LABEL[curLv.mech.latch], (doors & LATCH) !== 0],
    ["keys", cleared || out],
  ];

  return (
    <div className="app">
      <header>
        <h1>
          solsocket <span className="tag">escape-duo — a two-player vault on Solana</span>
        </h1>
        {phase === "live" && room && (
          <div className="status">
            <span className="dot live" /> vault{" "}
            <code>{room.address.toBase58().slice(0, 8)}…</code>
            <button onClick={() => navigator.clipboard.writeText(location.href)}>
              copy invite link
            </button>
            <span>{watchMode ? `watching · ${online}/2 inside` : `${online}/2 inside`}</span>
            {!watchMode && (
              <button
                onClick={() => navigator.clipboard.writeText(`${location.href}&watch=1`)}
              >
                copy watch link
              </button>
            )}
            <span className="metric">
              lvl {level + 1}/{LEVELS.length} · {lvName}
            </span>
            {clock && <span className="metric">⏱ {clock}</span>}
            <span className="metric">{txCount} onchain writes</span>
            {echo !== null && <span className="metric">{echo}ms echo</span>}
            <button onClick={() => setShowHint(true)}>how to play</button>
            <button
              onClick={() => {
                setMuted(!mute);
                setMute(!mute);
              }}
            >
              {mute ? "🔇" : "🔊"}
            </button>
            {cluster === "devnet" && (
              <a
                href={`https://explorer.solana.com/address/${room.address.toBase58()}?cluster=devnet`}
                target="_blank"
                rel="noreferrer"
              >
                explorer ↗
              </a>
            )}
          </div>
        )}
      </header>

      {phase === "funding" && (
        <div className="title">
          <div className="hero">
            <div className="kicker">solsocket presents</div>
            <h2 className="game-title">THE VAULT</h2>
            <div className="hero-sub">
              a two-player escape room on Solana — nine puzzles that are
              impossible alone, every move a zero-fee onchain transaction on a
              MagicBlock ephemeral rollup
              {cluster === "local" ? " (local stack)" : ""}
            </div>
            <div className="hero-tags">
              <span>⚡ ~50ms rollup writes</span>
              <span>0 fees in-game</span>
              <span>no game server</span>
            </div>
          </div>

          <div className="levels-row">
            {LEVELS.map((lv, i) => (
              <div key={lv.name} className={`level-card lv${i}`}>
                <div className="lv-num">LEVEL {i + 1}</div>
                <div className="lv-name">{lv.name}</div>
                <div className="lv-puzzles">
                  {STEP_LABEL[lv.mech.door1]} · {STEP_LABEL[lv.mech.locks]} ·{" "}
                  {STEP_LABEL[lv.mech.latch]}
                </div>
                <div className="lv-window">key window {(lv.keyWindowMs / 1000).toFixed(1)}s</div>
              </div>
            ))}
          </div>

          {watchMode ? (
            <div className="join-card">
              <p className="watch-blurb">
                <b>spectator mode</b> — you're about to watch a live vault read
                straight off the rollup. No transaction, no fees, your wallet
                never needs funding.
              </p>
              <button className="primary cta" onClick={enter}>
                ▶ watch this vault live
              </button>
            </div>
          ) : (
            <div className="join-card">
              <div className="join-row">
                <label className="name-field">
                  call sign
                  <input
                    value={name}
                    maxLength={12}
                    onChange={(e) => setName(e.target.value.replace(/[^\w-]/g, ""))}
                  />
                </label>
                <div className="wallet-field">
                  burner wallet
                  <div
                    className={`wallet-chip${balance !== null && balance >= 0.01 ? " ok" : ""}`}
                    title="click to copy the full address"
                    onClick={() =>
                      navigator.clipboard.writeText(wallet.publicKey.toBase58())
                    }
                  >
                    <span className="dot" />
                    <code>
                      {wallet.publicKey.toBase58().slice(0, 4)}…
                      {wallet.publicKey.toBase58().slice(-4)}
                    </code>
                    <span className="chip-bal">
                      {balance === null ? "…" : `${balance.toFixed(3)} SOL`}
                    </span>
                  </div>
                </div>
                {!(balance !== null && balance >= 0.01) && (
                  <button className="fund-btn" onClick={airdrop}>
                    get devnet SOL
                  </button>
                )}
              </div>
              <button
                className="primary cta"
                disabled={balance !== null && balance < 0.01}
                onClick={enter}
              >
                {joinTarget ? "▶ enter your partner's vault" : "▶ open a new vault"}
              </button>
              <div className="join-note">
                {balance !== null && balance >= 0.01
                  ? "rent covered — grab a partner and go"
                  : "needs ~0.01 devnet SOL once for vault rent — every move after that is free"}
              </div>
            </div>
          )}
          {error && <p className="error">{error}</p>}

          {!joinTarget && (board.length > 0 || live.length > 0) && (
            <div className="lobby">
              {board.length > 0 && (
                <div className="lobby-col">
                  <p className="lobby-head">
                    🏆 fastest escapes <span>· read off the rollup, no server</span>
                  </p>
                  {board.map((b, i) => (
                    <div key={b.addr} className="boardrow">
                      <span className={`rank r${i}`}>{i + 1}</span>
                      <span className="btime">{fmtTime(b.time)}</span>
                      <code>{b.addr.slice(0, 8)}…</code>
                    </div>
                  ))}
                </div>
              )}
              {live.length > 0 && (
                <div className="lobby-col">
                  <p className="lobby-head">
                    <span className="live-dot" /> live right now
                  </p>
                  {live.map((w) => (
                    <button
                      key={w.address.toBase58()}
                      className="live-row"
                      onClick={() => {
                        const suffix =
                          (cluster === "local" ? "&cluster=local" : "") +
                          (region ? `&region=${region}` : "");
                        location.href = `${location.pathname}?room=${w.address.toBase58()}${suffix}&watch=1`;
                      }}
                    >
                      <code>{w.address.toBase58().slice(0, 8)}…</code>
                      <span>{w.players}/2 inside</span>
                      <span className="watch-cta">watch ▸</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {phase === "connecting" && (
        <div className="panel">
          <span className="dot wait" /> {joinTarget ? "entering" : "creating"} the
          vault on the ephemeral rollup… (one base-layer transaction)
        </div>
      )}

      {phase === "error" && <div className="panel error">{error}</div>}

      <div className="stage" style={{ display: phase === "live" ? "block" : "none" }}>
        <canvas ref={canvasRef} width={WIDTH} height={HEIGHT} />
        {phase === "live" && !watchMode && online < 2 && level === 0 && !(doors & DOOR1) && !out && (
          <div className="hint">
            <b>waiting for your partner</b>
            <div>this vault needs two — send the invite link</div>
            <button onClick={() => navigator.clipboard.writeText(location.href)}>
              copy invite link
            </button>
          </div>
        )}
        {phase === "live" && !watchMode && online >= 2 && showHint && !out && !cleared && (
          <div className="hint" onClick={() => setShowHint(false)}>
            <b>escape together — {LEVELS.length} levels</b>
            <div>
              <kbd>W</kbd>
              <kbd>A</kbd>
              <kbd>S</kbd>
              <kbd>D</kbd> move · <kbd>Enter</kbd> chat · <kbd>E</kbd> use ·{" "}
              <kbd>0</kbd>–<kbd>9</kbd> keypad
            </div>
            <div>every level is a different set of puzzles — the banner</div>
            <div>at the bottom always tells you the current objective</div>
            <div>lvl 1 the vault: plates · code relay · held gate</div>
            <div>lvl 2 the reactor: valve sequence · fuel run · vent purge</div>
            <div>lvl 3 the core: glass bridge · cross levers · charge pads</div>
            <div>⚠ coolant, glass and vent steam send you back to spawn;</div>
            <div>cyan pulse walls only open on the beat — time your runs</div>
            <span className="hint-note">every action is an onchain tx · move to dismiss</span>
          </div>
        )}
        {cleared && (
          <div className="win">
            <b>
              LEVEL {level + 1} CLEARED
            </b>
            <div className="win-time">{clock}</div>
            <div>
              next: {LEVELS[Math.min(level + 1, LEVELS.length - 1)].name} — key window{" "}
              {(LEVELS[Math.min(level + 1, LEVELS.length - 1)].keyWindowMs / 1000).toFixed(1)}s
            </div>
            {!watchMode && (
              <button className="primary" onClick={advance}>
                next level →
              </button>
            )}
          </div>
        )}
        {out && (
          <div className="win">
            <b>ESCAPED — ALL {LEVELS.length} LEVELS</b>
            <div className="win-time">{clock}</div>
            <div>
              {txCount} onchain writes · every step a signed transaction
              {room && cluster === "devnet" && (
                <>
                  {" · "}
                  <a
                    href={`https://explorer.solana.com/address/${room.address.toBase58()}?cluster=devnet`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    verify the escape ↗
                  </a>
                </>
              )}
            </div>
            <button
              className="primary"
              onClick={() => {
                location.href =
                  location.pathname +
                  (cluster === "local" ? "?cluster=local" : region ? `?region=${region}` : "");
              }}
            >
              open a new vault
            </button>
          </div>
        )}
        {objective && !out && !cleared && <div className="objective">{objective}</div>}
        <div className="steps">
          {steps.map(([label, done]) => (
            <span key={label} className={done ? "step done" : "step"}>
              {done ? "✓" : "○"} {label}
            </span>
          ))}
        </div>
        {!watchMode && (
          <form className="chatbar" onSubmit={sendChat}>
            <input
              ref={chatInputRef}
              value={chatDraft}
              placeholder="Enter to chat — relay those codes · WASD move · E use"
              onChange={(e) => setChatDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && chatInputRef.current?.blur()}
            />
          </form>
        )}
      </div>
    </div>
  );
}
