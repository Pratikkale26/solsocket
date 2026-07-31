import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { PresenceEntry, Room, SolSocket, smoothPresence, structCodec } from "solsocket";
import {
  Avatar,
  ChatMsg,
  EMOTES,
  EmoteMsg,
  Overlay,
  PROXIMITY_TILES,
  WorldState,
  drawAvatar,
} from "./game";
import { DOOR, HEIGHT, SPAWN, TILE, WIDTH, drawWorld, near, walkable } from "./map";
import { loadBurnerWallet, requestAirdrop } from "./wallet";

const wallet = loadBurnerWallet();
const params = new URLSearchParams(location.search);
const cluster = params.get("cluster") === "local" ? ("local" as const) : ("devnet" as const);

type Msg = ChatMsg | EmoteMsg;
type World = Room<WorldState, Avatar, Msg>;

/* ──────────────────────────────────────────────────────────────────────────
 * The entire realtime integration. A multiplayer world on Solana:
 * binary presence for avatars, JSON events for chat/emotes, shared state
 * for the door — every one of them an onchain transaction on the ER.
 * ────────────────────────────────────────────────────────────────────────── */
const avatarCodec = structCodec<Avatar>([
  ["x", "u16"],
  ["y", "u16"],
  ["facing", "u8"],
  ["emote", "u8"],
  ["name", "string"],
]);

async function goLive(): Promise<World> {
  const sock = SolSocket.connect({ wallet, cluster });
  const opts = { presenceCodec: avatarCodec, initialState: { door: false } };
  const shared = params.get("room");
  const room = shared
    ? await sock.joinRoom<WorldState, Avatar, Msg>(new PublicKey(shared), opts)
    : await sock.createRoom<WorldState, Avatar, Msg>(opts);
  const suffix = cluster === "local" ? "&cluster=local" : "";
  history.replaceState(null, "", `?room=${room.address.toBase58()}${suffix}`);
  return room;
}
/* ────────────────────────────────────────────────────────────────────────── */

function loadName(): string {
  return (
    localStorage.getItem("solsocket-gather:name") ??
    `anon-${wallet.publicKey.toBase58().slice(0, 4)}`
  );
}

export default function App() {
  const [phase, setPhase] = useState<"funding" | "connecting" | "live" | "error">(
    "funding",
  );
  const [error, setError] = useState("");
  const [balance, setBalance] = useState<number | null>(null);
  const [name, setName] = useState(loadName);
  const [doorOpen, setDoorOpen] = useState(false);
  const [online, setOnline] = useState(1);
  const [txCount, setTxCount] = useState(0);
  const [echo, setEcho] = useState<number | null>(null);
  const [chatDraft, setChatDraft] = useState("");

  const roomRef = useRef<World | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chatInputRef = useRef<HTMLInputElement>(null);
  const remotes = useRef<ReadonlyMap<string, PresenceEntry<Avatar>>>(new Map());
  const chats = useRef(new Map<string, Overlay>());
  const emotes = useRef(new Map<string, Overlay>());
  const door = useRef(false);
  const sent = useRef(0);
  const sentAt = useRef(0);

  const selfKey = wallet.publicKey.toBase58();

  const refreshBalance = useCallback(async () => {
    const sock = SolSocket.connect({ wallet, cluster });
    const lamports = await sock.base.getBalance(wallet.publicKey);
    setBalance(lamports / LAMPORTS_PER_SOL);
    return lamports;
  }, []);

  useEffect(() => {
    void refreshBalance();
  }, [refreshBalance]);

  const enter = async () => {
    localStorage.setItem("solsocket-gather:name", name);
    setPhase("connecting");
    try {
      const room = await goLive();
      roomRef.current = room;
      room.onStateChange(({ state }) => {
        door.current = state.door;
        setDoorOpen(state.door);
      });
      const state = await room.getState();
      if (state) {
        door.current = state.state.door;
        setDoorOpen(state.state.door);
      }
      room.onMessage("chat", ({ player, data }) => {
        chats.current.set(player.toBase58(), {
          text: (data as ChatMsg).text,
          until: Date.now() + 5_000,
        });
      });
      room.onMessage("emote", ({ player, data }) => {
        emotes.current.set(player.toBase58(), {
          text: EMOTES[(data as EmoteMsg).kind] ?? "✨",
          until: Date.now() + 2_500,
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
    const me = { x: SPAWN.x, y: SPAWN.y, facing: 0 };
    let lastSend = 0;
    let lastMoved = 0;
    let raf = 0;
    let last = performance.now();

    const typing = () => document.activeElement === chatInputRef.current;

    const broadcast = (force = false) => {
      const now = Date.now();
      if (!force && now - lastSend < 100) return;
      lastSend = now;
      sentAt.current = now;
      sent.current += 1;
      void roomRef.current?.broadcast({
        x: Math.round(me.x),
        y: Math.round(me.y),
        facing: me.facing,
        emote: 0,
        name,
      });
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        chatInputRef.current?.focus();
        return;
      }
      if (typing()) return;
      keys.add(e.key.toLowerCase());
      const emoteIdx = ["1", "2", "3", "4"].indexOf(e.key);
      if (emoteIdx >= 0) {
        sent.current += 1;
        void roomRef.current?.emit("emote", { kind: emoteIdx });
      }
      if (e.key.toLowerCase() === "e" && near(me.x, me.y, DOOR.x, DOOR.y, 2)) {
        sent.current += 1;
        void roomRef.current?.setState({ door: !door.current });
      }
    };
    const onKeyUp = (e: KeyboardEvent) => keys.delete(e.key.toLowerCase());
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    const counters = setInterval(() => {
      setTxCount(sent.current);
      setOnline(
        1 + [...remotes.current.keys()].filter((k) => k !== selfKey).length,
      );
      // Heartbeat keeps us on other players' rosters while idle.
      if (Date.now() - lastSend > 2_500) broadcast(true);
    }, 500);

    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;

      if (!typing()) {
        const speed = 130;
        let vx = 0;
        let vy = 0;
        if (keys.has("arrowleft") || keys.has("a")) vx -= 1;
        if (keys.has("arrowright") || keys.has("d")) vx += 1;
        if (keys.has("arrowup") || keys.has("w")) vy -= 1;
        if (keys.has("arrowdown") || keys.has("s")) vy += 1;
        if (vx || vy) {
          const len = Math.hypot(vx, vy);
          const nx = me.x + (vx / len) * speed * dt;
          const ny = me.y + (vy / len) * speed * dt;
          if (walkable(nx, me.y, door.current)) me.x = nx;
          if (walkable(me.x, ny, door.current)) me.y = ny;
          me.facing = vy < 0 ? 3 : vx < 0 ? 1 : vx > 0 ? 2 : 0;
          lastMoved = Date.now();
        }
        if (Date.now() - lastMoved < 200) broadcast();
      }

      drawWorld(ctx, door.current, now);

      if (near(me.x, me.y, DOOR.x, DOOR.y, 2)) {
        ctx.font = "11px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.fillStyle = "rgba(255,255,255,0.9)";
        ctx.fillText(`[E] ${door.current ? "close" : "open"} door`, DOOR.x, DOOR.y - 20);
      }

      for (const [key, p] of remotes.current) {
        if (key === selfKey) continue;
        drawAvatar(ctx, key, p.data, {
          nearby: near(me.x, me.y, p.data.x, p.data.y, PROXIMITY_TILES),
          chat: chats.current.get(key),
          emote: emotes.current.get(key),
        });
      }
      drawAvatar(
        ctx,
        selfKey,
        { x: me.x, y: me.y, facing: me.facing, emote: 0, name },
        { self: true, chat: chats.current.get(selfKey), emote: emotes.current.get(selfKey) },
      );

      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      clearInterval(counters);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
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
  return (
    <div className="app">
      <header>
        <h1>
          solsocket <span className="tag">gather-lite — a world on Solana</span>
        </h1>
        {phase === "live" && room && (
          <div className="status">
            <span className="dot live" /> room{" "}
            <code>{room.address.toBase58().slice(0, 8)}…</code>
            <button onClick={() => navigator.clipboard.writeText(location.href)}>
              copy invite link
            </button>
            <span>{online} online</span>
            <span className="metric">{txCount} onchain writes</span>
            {echo !== null && <span className="metric">{echo}ms echo</span>}
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
            A tiny Gather-style world where <b>every avatar is a wallet</b>: movement
            is a binary presence broadcast, chat and emotes are onchain events, the
            door is shared room state — all zero-fee transactions on a MagicBlock
            ephemeral rollup{cluster === "local" ? " (local stack)" : " (devnet)"}.
          </p>
          <p>
            burner: <code>{wallet.publicKey.toBase58()}</code>
            <br />
            balance: {balance === null ? "…" : `${balance.toFixed(4)} SOL`} — needs
            ~0.01 once for room rent
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
              enter the world
            </button>
          </div>
          {error && <p className="error">{error}</p>}
        </div>
      )}

      {phase === "connecting" && (
        <div className="panel">
          <span className="dot wait" /> {params.get("room") ? "joining" : "creating"}{" "}
          the world on the ephemeral rollup… (one base-layer transaction)
        </div>
      )}

      {phase === "error" && <div className="panel error">{error}</div>}

      <div className="stage" style={{ display: phase === "live" ? "block" : "none" }}>
        <canvas ref={canvasRef} width={WIDTH} height={HEIGHT} />
        <form className="chatbar" onSubmit={sendChat}>
          <input
            ref={chatInputRef}
            value={chatDraft}
            placeholder="Enter to chat (heard within 4 tiles) · WASD move · 1-4 emote · E door"
            onChange={(e) => setChatDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && chatInputRef.current?.blur()}
          />
        </form>
      </div>
    </div>
  );
}
