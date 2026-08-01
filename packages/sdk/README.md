# solsocket

**Socket.io for Solana.** Realtime multiplayer rooms — fully onchain, powered by
[MagicBlock Ephemeral Rollups](https://docs.magicblock.gg).

```bash
npm install solsocket
```

```ts
import { SolSocket } from "solsocket";

const sock = SolSocket.connect({ wallet, cluster: "devnet", region: "eu" });
const room = await sock.joinOrCreate<State>("lobby"); // same name → same room

room.onPresence(({ player, data }) => drawCursor(player, data)); // ~50ms
await room.broadcast({ x: 0.4, y: 0.7 }); // zero-fee, no wallet popup

room.onMessage("chat", ({ player, data }) => bubble(player, data));
await room.emit("chat", { text: "gm" }); // event in tx logs — no state write
```

- **One wallet signature** creates a room, joins it, and delegates it to an
  ephemeral rollup — a single base-layer transaction.
- **Zero-fee realtime writes** signed by an auto-managed session key
  (localStorage), so there are no popups after join.
- **~50ms updates** via `processed`-commitment websocket subscriptions straight
  from the ER — not 4–8s HTTP confirm polling.
- **Real Solana state**: rooms and presence are ordinary accounts; `leave()` and
  `closeToBase()` commit them back to the base layer.

## API

| Call | What it does |
|---|---|
| `SolSocket.connect({ wallet, cluster, region? })` | `wallet` = adapter or `Keypair`; `cluster` = `"devnet"`, `"local"`, or custom; `region` = `"asia" \| "eu" \| "us"` |
| `sock.joinOrCreate<T>("name", opts?)` | named room — every client asking for `"lobby"` lands in the same room |
| `sock.createRoom<T>(opts?)` | create + join + delegate in one tx → `Room<T>` |
| `sock.joinRoom<T>(address)` | join an existing room (handles rejoin/lost session) |
| `sock.listRooms()` | every room live on the ER with player counts, busiest first |
| `sock.peekState(address)` | read any room's state without joining — leaderboards, lobby previews |
| `sock.spectate(address)` | watch a room read-only: live subscriptions, zero transactions, wallet never needs funding |
| `room.broadcast(data)` | write your presence slot (fire-and-forget) |
| `room.emit(name, data)` | ephemeral event in tx logs — chat, hits, reactions; no state write |
| `room.setState(data)` | write the shared room state |
| `room.onPresence(cb)` / `room.onStateChange(cb)` / `room.onMessage(name?, cb)` | subscribe; returns unsubscribe fn |
| `room.getState()` | read current shared state from the ER |
| `room.leave()` | commit + undelegate your presence (session-signed) |
| `room.closeToBase()` | creator: commit + undelegate the room |

Helpers: `trackPresence(room, { onJoin, onUpdate, onLeave })` — roster with
staleness sweeping (no ghost avatars) — and `smoothPresence(room, render)` —
entity interpolation that renders 10Hz broadcasts as 60fps movement.

State, presence, and messages each take their own pluggable codec
(`Room<TState, TPresence, TMessage>`): JSON by default, `structCodec` for
compact binary structs (a full avatar in ~20 bytes), `rawCodec` for bytes.

The on-chain program (`solsocket-engine`) is deployed on devnet at
[`CrLS1Ry58q59AgmqbNVrqbfs2bWGJtjk12PezXh4LeYh`](https://explorer.solana.com/address/CrLS1Ry58q59AgmqbNVrqbfs2bWGJtjk12PezXh4LeYh?cluster=devnet).

Full docs, Anchor program source, and a shared-cursor demo:
[github.com/Pratikkale26/solsocket](https://github.com/Pratikkale26/solsocket)

MIT © Pratik Kale
