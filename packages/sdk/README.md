# solsocket

**Socket.io for Solana.** Realtime multiplayer rooms — fully onchain, powered by
[MagicBlock Ephemeral Rollups](https://docs.magicblock.gg).

```bash
npm install solsocket
```

```ts
import { SolSocket } from "solsocket";

const sock = SolSocket.connect({ wallet, cluster: "devnet" });

// creator
const room = await sock.createRoom<{ x: number; y: number }>();
console.log("invite:", room.address.toBase58());

// everyone
room.onPresence(({ player, data }) => drawCursor(player, data)); // ~50ms
await room.broadcast({ x: 0.4, y: 0.7 }); // zero-fee, no wallet popup
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
| `SolSocket.connect({ wallet, cluster })` | `wallet` = adapter or `Keypair`; `cluster` = `"devnet"`, `"local"`, or custom endpoints |
| `sock.createRoom<T>(opts?)` | create + join + delegate in one tx → `Room<T>` |
| `sock.joinRoom<T>(address)` | join an existing room (handles rejoin/lost session) |
| `room.broadcast(data)` | write your presence slot (fire-and-forget) |
| `room.setState(data)` | write the shared room state |
| `room.onPresence(cb)` / `room.onStateChange(cb)` | subscribe; returns unsubscribe fn |
| `room.getState()` | read current shared state from the ER |
| `room.leave()` | commit + undelegate your presence (session-signed) |
| `room.closeToBase()` | creator: commit + undelegate the room |

Payloads go through a pluggable `Codec<T>` — JSON by default, `rawCodec` for bytes.

The on-chain program (`solsocket-engine`) is deployed on devnet at
[`CrLS1Ry58q59AgmqbNVrqbfs2bWGJtjk12PezXh4LeYh`](https://explorer.solana.com/address/CrLS1Ry58q59AgmqbNVrqbfs2bWGJtjk12PezXh4LeYh?cluster=devnet).

Full docs, Anchor program source, and a shared-cursor demo:
[github.com/Pratikkale26/solsocket](https://github.com/Pratikkale26/solsocket)

MIT © Pratik Kale
