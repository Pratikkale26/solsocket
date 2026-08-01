import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { PresenceEntry, Room, SolSocket, smoothPresence, structCodec } from "solsocket";
import {
  Bubble,
  DOOR1,
  LATCH,
  LEVELS,
  LOCK1,
  LOCK2,
  HEIGHT,
  VaultState,
  WIDTH,
  codesFor,
  drawPlayer,
  drawVault,
  isFinal,
  levelOf,
  near,
  solvedKeys,
  tileUnder,
  walkable,
} from "./vault";
import { loadBurnerWallet, requestAirdrop } from "./wallet";

const wallet = loadBurnerWallet();
const params = new URLSearchParams(location.search);
const cluster = params.get("cluster") === "local" ? ("local" as const) : ("devnet" as const);
const REGIONS = ["asia", "eu", "us"] as const;
const region =
  cluster === "devnet" ? REGIONS.find((r) => r === params.get("region")) : undefined;

type Player = { x: number; y: number; facing: number; name: string };
type ChatMsg = { text: string };
type Vault = Room<VaultState, Player, ChatMsg>;

const joinTarget = params.get("room");

/* ──────────────────────────────────────────────────────────────────────────
 * The realtime integration: binary presence for the two players, shared
 * vault state for the puzzles, events for chat — all zero-fee onchain
 * transactions on a MagicBlock ephemeral rollup.
 * ────────────────────────────────────────────────────────────────────────── */
const playerCodec = structCodec<Player>([
  ["x", "u16"],
  ["y", "u16"],
  ["facing", "u8"],
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
  const room = joinTarget
    ? await sock.joinRoom<VaultState, Player, ChatMsg>(new PublicKey(joinTarget), opts)
    : await sock.createRoom<VaultState, Player, ChatMsg>({
        ...opts,
        maxPlayers: 2,
        initialState: FRESH_VAULT,
      });
  const suffix =
    (cluster === "local" ? "&cluster=local" : "") + (region ? `&region=${region}` : "");
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
  }, [refreshBalance]);

  const syncUi = () => {
    const v = vault.current;
    setDoors(v.doors);
    setLevel(v.level);
    const solved = solvedKeys(v);
    setOut(solved && isFinal(v));
    setCleared(solved && !isFinal(v));
  };

  /** Send the vault state, retrying through transient ER failures — a
   *  silently dropped write would leave the two players in different
   *  realities, which is worse than a late one. */
  const pushState = (tries = 5) => {
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
      const roleKey = `solsocket-escape:role:${room.address.toBase58()}`;
      const stored = localStorage.getItem(roleKey);
      roleRef.current = stored !== null ? Number(stored) : joinTarget ? 1 : 0;
      localStorage.setItem(roleKey, String(roleRef.current));
      room.onStateChange(({ state }) => applyState(state));
      const first = await room.getState();
      if (first) applyState(first.state);
      room.onMessage("chat", ({ player, data }) => {
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
    let raf = 0;
    let last = performance.now();

    const typing = () => document.activeElement === chatInputRef.current;
    const room = () => roomRef.current;

    const partner = () => {
      const p = partnerKey();
      return p ? remotes.current.get(p) : undefined;
    };

    const broadcast = (force = false) => {
      const now = Date.now();
      if (!force && now - lastSend < 100) return;
      lastSend = now;
      sentAt.current = now;
      sent.current += 1;
      void room()?.broadcast({
        x: Math.round(me.x),
        y: Math.round(me.y),
        facing: me.facing,
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
        chats.current.set(selfKey, { text: "✗ wrong code", until: Date.now() + 1_500 });
      }
      buf.current = "";
    };

    const onKeyDown = (e: KeyboardEvent) => {
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
        const pad = myPad();
        const theirs = myRole() === 0 ? lv().pos.k : lv().pos.K;
        if (near(me.x, me.y, pad.x, pad.y, 1.6)) {
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
      const d = vault.current.doors;
      if (near(me.x, me.y, L.pos.S.x, L.pos.S.y, 1.3) && !(d & LATCH)) {
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
      setOnline(1 + [...remotes.current.keys()].filter((k) => k !== selfKey).length);
      const v = vault.current;
      if (v.run > 0)
        setClock(
          fmtTime(
            (solvedKeys(v) && isFinal(v) ? Math.max(v.keyA, v.keyB) : Date.now()) - v.run,
          ),
        );
      if (Date.now() - lastSend > 2_500) broadcast(true);
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
        broadcast(true);
      }

      const p = partner();
      const pTile = p ? tileUnder(L, p.data.x, p.data.y) : "";
      const myTile = tileUnder(L, me.x, me.y);
      const leverHeld = myTile === "L" || pTile === "L";
      const frozen = solvedKeys(v);

      if (!typing() && !frozen) {
        const speed = 130;
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
          if (walkable(L, nx, me.y, v.doors, leverHeld)) me.x = nx;
          if (walkable(L, me.x, ny, v.doors, leverHeld)) me.y = ny;
          me.facing = vy < 0 ? 3 : vx < 0 ? 1 : vx > 0 ? 2 : 0;
          lastMoved = Date.now();
        }
        if (Date.now() - lastMoved < 200) broadcast();
      }

      // Puzzle 1: door 1 latches open while both plates are pressed. Keep
      // re-firing on a cooldown until the state sticks — a single dropped
      // write must never dead-lock the vault.
      if (
        !(v.doors & DOOR1) &&
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

      // A half-typed code shouldn't linger: walking away clears the keypad.
      if (buf.current && !near(me.x, me.y, myPad().x, myPad().y, 1.6)) buf.current = "";

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
      });

      // contextual prompts
      ctx.font = "11px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      const pad = myPad();
      const theirPad = myRole() === 0 ? L.pos.k : L.pos.K;
      const padSolved = v.doors & (myRole() === 0 ? LOCK2 : LOCK1);
      const winS = (L.keyWindowMs / 1000).toFixed(1).replace(/\.0$/, "");
      if (!padSolved && near(me.x, me.y, pad.x, pad.y, 1.5))
        ctx.fillText("type the 4 digits your partner reads out", pad.x, pad.y - 24);
      if (near(me.x, me.y, theirPad.x, theirPad.y, 1.5))
        ctx.fillText("your partner's keypad — read them your panel", theirPad.x, theirPad.y - 24);
      if (!(v.doors & LATCH) && near(me.x, me.y, L.pos.S.x, L.pos.S.y, 1.5))
        ctx.fillText("[E] lock the gate open", L.pos.S.x, L.pos.S.y - 20);
      if (myRole() === 0 && near(me.x, me.y, L.pos.A.x, L.pos.A.y, 1.5))
        ctx.fillText(`[E] turn key A — together, within ${winS}s`, L.pos.A.x, L.pos.A.y - 24);
      if (myRole() === 1 && near(me.x, me.y, L.pos.B.x, L.pos.B.y, 1.5))
        ctx.fillText(`[E] turn key B — together, within ${winS}s`, L.pos.B.x, L.pos.B.y - 24);

      for (const [key, pp] of remotes.current) {
        if (key === selfKey) continue;
        drawPlayer(ctx, key, pp.data, { chat: chats.current.get(key) });
      }
      drawPlayer(
        ctx,
        selfKey,
        { x: me.x, y: me.y, facing: me.facing, name },
        { self: true, chat: chats.current.get(selfKey) },
      );

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
        "Airdrop failed (devnet faucet rate limit). Send ~0.01 devnet SOL to the burner above, then reload.",
      );
    }
  };

  const room = roomRef.current;
  const lvName = LEVELS[Math.min(level, LEVELS.length - 1)].name;
  const objective = !room
    ? ""
    : online < 2 && !(doors & DOOR1) && level === 0 && !out
      ? "waiting for your partner — this vault needs two"
      : out
        ? "you escaped — verify it on the explorer"
        : cleared
          ? "level cleared — hit next level when you're both ready"
          : !(doors & DOOR1)
            ? "① one of you on each glowing plate — at the same moment"
            : !(doors & LOCK1) || !(doors & LOCK2)
              ? "② read your green panel to your partner (Enter to chat) — type the code they read you on your yellow keypad (0-9)"
              : !(doors & LATCH)
                ? "③ one stands on the lever to hold the gate — the other walks through and presses E on the switch"
                : `④ you are key ${myRole() === 0 ? "A" : "B"} — count down in chat, both press E together`;
  const steps: [string, boolean][] = [
    ["plates", (doors & DOOR1) !== 0],
    ["codes", (doors & LOCK1) !== 0 && (doors & LOCK2) !== 0],
    ["gate", (doors & LATCH) !== 0],
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
            <span>{online}/2 inside</span>
            <span className="metric">
              lvl {level + 1}/{LEVELS.length} · {lvName}
            </span>
            {clock && <span className="metric">⏱ {clock}</span>}
            <span className="metric">{txCount} onchain writes</span>
            {echo !== null && <span className="metric">{echo}ms echo</span>}
            <button onClick={() => setShowHint(true)}>how to play</button>
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
        <div className="panel">
          <p>
            <b>The Vault</b> — MagicBlock's co-op escape room idea, built on
            solsocket. {LEVELS.length} levels of puzzles that are impossible
            alone: pressure plates you both stand on, codes only your partner
            can read, a gate one of you holds open, and two keys turned in the
            same shrinking window. Every move is a zero-fee onchain transaction
            on an ephemeral rollup
            {cluster === "local" ? " (local stack)" : " (devnet)"}.
          </p>
          <p>
            burner: <code>{wallet.publicKey.toBase58()}</code>
            <br />
            balance: {balance === null ? "…" : `${balance.toFixed(4)} SOL`} — needs
            ~0.01 once for vault rent
          </p>
          <label>
            display name{" "}
            <input
              value={name}
              maxLength={12}
              onChange={(e) => setName(e.target.value.replace(/[^\w-]/g, ""))}
            />
          </label>
          <div className="row">
            <button onClick={airdrop}>request devnet airdrop</button>
            <button
              className="primary"
              disabled={balance !== null && balance < 0.01}
              onClick={enter}
            >
              {joinTarget ? "enter your partner's vault" : "open a new vault"}
            </button>
          </div>
          {error && <p className="error">{error}</p>}
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
        {phase === "live" && online < 2 && level === 0 && !(doors & DOOR1) && !out && (
          <div className="hint">
            <b>waiting for your partner</b>
            <div>this vault needs two — send the invite link</div>
            <button onClick={() => navigator.clipboard.writeText(location.href)}>
              copy invite link
            </button>
          </div>
        )}
        {phase === "live" && online >= 2 && showHint && !out && !cleared && (
          <div className="hint" onClick={() => setShowHint(false)}>
            <b>escape together — {LEVELS.length} levels</b>
            <div>
              <kbd>W</kbd>
              <kbd>A</kbd>
              <kbd>S</kbd>
              <kbd>D</kbd> move · <kbd>Enter</kbd> chat · <kbd>E</kbd> use ·{" "}
              <kbd>0</kbd>–<kbd>9</kbd> keypad
            </div>
            <div>1 — stand on both plates at the same time</div>
            <div>2 — read your panel aloud; type the code you're told</div>
            <div>3 — one holds the lever, one locks the gate</div>
            <div>4 — turn both keys together (the window shrinks each level)</div>
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
            <button className="primary" onClick={advance}>
              next level →
            </button>
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
        <form className="chatbar" onSubmit={sendChat}>
          <input
            ref={chatInputRef}
            value={chatDraft}
            placeholder="Enter to chat — relay those codes · WASD move · E use"
            onChange={(e) => setChatDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && chatInputRef.current?.blur()}
          />
        </form>
      </div>
    </div>
  );
}
