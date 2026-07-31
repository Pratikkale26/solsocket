# solsocket

**Socket.io for Solana.** Realtime multiplayer rooms — fully onchain, powered by
[MagicBlock Ephemeral Rollups](https://docs.magicblock.gg).

```ts
import { SolSocket } from "solsocket";

const sock = SolSocket.connect({ wallet, cluster: "devnet" });
const room = await sock.createRoom<{ x: number; y: number }>();

room.onPresence(({ player, data }) => drawCursor(player, data)); // ~50ms updates
await room.broadcast({ x: 0.4, y: 0.7 }); // zero-fee, no wallet popup
```

One wallet signature to create/join a room. After that, every `broadcast()` is a
**zero-fee transaction signed by a throwaway session key** and every remote update
arrives over a websocket at **ephemeral-rollup slot time (~50ms)** — while all
state remains real Solana accounts you can commit back to the base layer.

## Why

Building realtime multiplayer on Solana today means hand-rolling: two RPC
connections, delegate→ER→undelegate sequencing, validator identities as remaining
accounts, commitment-level footguns (`confirmed` subscriptions silently don't fire
on ERs), and session-key plumbing. MagicBlock's BOLT framework is deprecated;
what's left is low-level. solsocket wraps all of it behind the API every web dev
already knows: **rooms, broadcast, subscribe**.

Naive Anchor round-trip on an ER: **4–8 s** perceived latency (HTTP confirm
polling). solsocket's `processed`-commitment websocket path: **~50 ms**. Measured
in [`packages/sdk/tests/e2e.ts`](packages/sdk/tests/e2e.ts) — cross-client
delivery in **54ms** on a local ER.

## How it works

```
 base layer (Solana devnet)              ephemeral rollup (MagicBlock)
┌──────────────────────────┐   delegate  ┌────────────────────────────┐
│ Room PDA [room,creator,id]──────────▶  │ Room     (seq, state blob)  │
│ Presence PDA [room,player]──────────▶  │ Presence (seq, data blob)   │
│  · created + joined in     │           │  · session-key writes, 0 fee│
│    ONE wallet-signed tx    │◀──────────│  · processed-commitment WS  │
└──────────────────────────┘ commit /    └────────────────────────────┘
                             undelegate
```

- **Room** = shared state slot (last-write-wins, `seq`-ordered), delegated to an ER.
- **Presence** = one slot per player (cursor, status…) — concurrent players never
  contend on the same account. `onPresence` is a single `programSubscribe`
  filtered by room.
- **Session keys**: ER transactions are zero-fee, so a localStorage keypair
  registered at join signs all realtime writes. Losing it is fine — rejoin
  rotates the authority via a wallet-signed recovery path.

## Packages

| Path | What |
|---|---|
| [`packages/sdk`](packages/sdk) | `solsocket` — the TypeScript SDK (web3.js, dual CJS/ESM) |
| [`program`](program) | `solsocket-engine` — Anchor program, devnet: [`CrLS1Ry58q59AgmqbNVrqbfs2bWGJtjk12PezXh4LeYh`](https://explorer.solana.com/address/CrLS1Ry58q59AgmqbNVrqbfs2bWGJtjk12PezXh4LeYh?cluster=devnet) |
| [`examples/cursor-canvas`](examples/cursor-canvas) | Shared-cursor demo — the whole integration is ~15 lines |

## Run it

```bash
pnpm install

# demo against devnet (uses the deployed program)
pnpm --filter @solsocket/cursor-canvas dev
# open http://localhost:5173, fund the burner (~0.01 devnet SOL), move your
# mouse, open the invite link in a second window.

# full local stack (base validator + ephemeral rollup)
npm i -g @magicblock-labs/ephemeral-validator
./scripts/local-stack.sh                          # terminal 1
pnpm --filter @solsocket/program test:local       # program lifecycle (9 tests)
pnpm --filter solsocket test:local                # SDK two-client e2e (5 tests)
```

Toolchain: Node ≥ 20, pnpm, and for program development Anchor **1.0.2** (avm),
Solana CLI 3.x, Rust 1.89+.

## API sketch

```ts
SolSocket.connect({ wallet, cluster: "devnet" | "local" | custom, session? })
sock.createRoom<T>({ id?, maxPlayers?, initialState?, codec? })  → Room<T>
sock.joinRoom<T>(address)                                        → Room<T>
room.broadcast(data)         // write own presence slot (fire-and-forget)
room.setState(data)          // write shared room state
room.onPresence(cb)          // every player's updates, ~50ms
room.onStateChange(cb)       // shared-state updates, ~50ms
room.getState()              // read from the ER
room.leave()                 // commit + undelegate own presence (session-signed)
room.closeToBase()           // creator: commit + undelegate the room
```

Payloads are pluggable `Codec<T>`s (JSON by default, raw bytes available).

## Status & roadmap

Built during [MagicBlock Solana Blitz v7](https://hackathon.magicblock.app)
(theme: Collaboration). Working now: everything above, tested on the local
MagicBlock stack and Solana devnet. Next: room discovery/registry,
`create-solsocket` scaffold CLI, ephemeral-message events (no state write),
multi-region ER selection, gum session-token integration for authority-gated
instructions.

## License

MIT © Pratik Kale
