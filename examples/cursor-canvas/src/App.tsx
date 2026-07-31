import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { Room, SolSocket } from "solsocket";
import { loadBurnerWallet, requestAirdrop } from "./wallet";

type Cursor = { x: number; y: number };

const wallet = loadBurnerWallet();

/* ──────────────────────────────────────────────────────────────────────────
 * The entire realtime integration. This is the demo:
 * an onchain multiplayer canvas in ~15 lines of solsocket.
 * ────────────────────────────────────────────────────────────────────────── */
async function goLive(
  onCursor: (player: string, c: Cursor) => void,
): Promise<Room<Cursor>> {
  const sock = SolSocket.connect({ wallet, cluster: "devnet" });
  const shared = new URLSearchParams(location.search).get("room");
  const room = shared
    ? await sock.joinRoom<Cursor>(new PublicKey(shared))
    : await sock.createRoom<Cursor>();
  history.replaceState(null, "", `?room=${room.address.toBase58()}`);
  room.onPresence(({ player, data }) => onCursor(player.toBase58(), data));
  return room;
}
/* ────────────────────────────────────────────────────────────────────────── */

const hueOf = (key: string) =>
  [...key].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 0);

export default function App() {
  const [phase, setPhase] = useState<"funding" | "connecting" | "live" | "error">(
    "funding",
  );
  const [error, setError] = useState("");
  const [balance, setBalance] = useState<number | null>(null);
  const [cursors, setCursors] = useState<Map<string, Cursor>>(new Map());
  const [lastEcho, setLastEcho] = useState<number | null>(null);
  const roomRef = useRef<Room<Cursor> | null>(null);
  const sentAt = useRef<number>(0);
  const lastSend = useRef<number>(0);

  const refreshBalance = useCallback(async () => {
    const sock = SolSocket.connect({ wallet, cluster: "devnet" });
    const lamports = await sock.base.getBalance(wallet.publicKey);
    setBalance(lamports / LAMPORTS_PER_SOL);
    return lamports;
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const lamports = await refreshBalance();
        if (lamports < 0.01 * LAMPORTS_PER_SOL) return; // stay in "funding"
        setPhase("connecting");
        roomRef.current = await goLive((player, c) => {
          if (player === wallet.publicKey.toBase58()) {
            setLastEcho(Date.now() - sentAt.current);
            return;
          }
          setCursors((prev) => new Map(prev).set(player, c));
        });
        setPhase("live");
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setPhase("error");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const room = roomRef.current;
    if (!room || Date.now() - lastSend.current < 50) return;
    lastSend.current = Date.now();
    sentAt.current = Date.now();
    const rect = e.currentTarget.getBoundingClientRect();
    const c = {
      x: (e.clientX - rect.left) / rect.width,
      y: (e.clientY - rect.top) / rect.height,
    };
    void room.broadcast(c);
  };

  const airdrop = async () => {
    setError("");
    try {
      const sock = SolSocket.connect({ wallet, cluster: "devnet" });
      await requestAirdrop(sock.base, wallet);
      window.location.reload();
    } catch (e) {
      setError(
        "Airdrop failed (devnet faucet rate limit). Send ~0.01 devnet SOL to the address above, then reload.",
      );
    }
  };

  return (
    <div className="app">
      <header>
        <h1>
          solsocket <span className="tag">shared cursors, fully onchain</span>
        </h1>
        <div className="status">
          {phase === "live" && roomRef.current && (
            <>
              <span className="dot live" /> room{" "}
              <code>{roomRef.current.address.toBase58().slice(0, 8)}…</code>
              <button
                onClick={() => navigator.clipboard.writeText(location.href)}
              >
                copy invite link
              </button>
              <span>{cursors.size + 1} online</span>
              {lastEcho !== null && <span className="latency">{lastEcho}ms echo</span>}
            </>
          )}
          {phase === "connecting" && (
            <>
              <span className="dot wait" /> creating room on the ephemeral rollup…
            </>
          )}
        </div>
      </header>

      {phase === "funding" && (
        <div className="panel">
          <p>
            This demo runs on <b>Solana devnet</b>. Your browser burner wallet needs
            ~0.01 devnet SOL once (room rent); every cursor movement after that is a
            <b> zero-fee onchain transaction</b>.
          </p>
          <p>
            burner: <code>{wallet.publicKey.toBase58()}</code>
            <br />
            balance: {balance === null ? "…" : `${balance.toFixed(4)} SOL`}
          </p>
          <button onClick={airdrop}>request devnet airdrop</button>
          <button onClick={() => window.location.reload()}>reload</button>
          {error && <p className="error">{error}</p>}
        </div>
      )}

      {phase === "error" && <div className="panel error">{error}</div>}

      <div className="canvas" onMouseMove={onMove}>
        {[...cursors.entries()].map(([player, c]) => (
          <div
            key={player}
            className="cursor"
            style={{
              left: `${c.x * 100}%`,
              top: `${c.y * 100}%`,
              color: `hsl(${hueOf(player)} 80% 55%)`,
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24">
              <path
                d="M4 2l16 8-7 2-2 7z"
                fill="currentColor"
                stroke="white"
                strokeWidth="1.5"
              />
            </svg>
            <span>{player.slice(0, 4)}</span>
          </div>
        ))}
        {phase === "live" && cursors.size === 0 && (
          <p className="hint">
            Open the invite link in a second window — every cursor you see is read
            from Solana at ~50ms.
          </p>
        )}
      </div>
    </div>
  );
}
