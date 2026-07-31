# solsocket

**Socket.io for Solana.** Realtime multiplayer rooms — fully onchain, powered by
[MagicBlock Ephemeral Rollups](https://docs.magicblock.gg).

```bash
npm create solsocket   # scaffold a working realtime onchain app
```

```ts
import { SolSocket } from "solsocket";

const sock = SolSocket.connect({ wallet, cluster: "devnet" });
const room = await sock.joinOrCreate<State>("lobby"); // named rooms, no branching

room.onPresence(({ player, data }) => drawCursor(player, data)); // ~50ms updates
await room.broadcast({ x: 0.4, y: 0.7 }); // zero-fee, no wallet popup

room.onMessage("chat", ({ player, data }) => bubble(player, data));
await room.emit("chat", { text: "gm" }); // events in tx logs — no state write
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
| [`packages/sdk`](packages/sdk) | [`solsocket`](https://www.npmjs.com/package/solsocket) — the TypeScript SDK (web3.js, dual CJS/ESM) |
| [`packages/create-solsocket`](packages/create-solsocket) | [`create-solsocket`](https://www.npmjs.com/package/create-solsocket) — `npm create solsocket` scaffolder |
| [`program`](program) | `solsocket-engine` — Anchor program, devnet: [`CrLS1Ry58q59AgmqbNVrqbfs2bWGJtjk12PezXh4LeYh`](https://explorer.solana.com/address/CrLS1Ry58q59AgmqbNVrqbfs2bWGJtjk12PezXh4LeYh?cluster=devnet) |
| [`examples/cursor-canvas`](examples/cursor-canvas) | Shared-cursor demo — the whole integration is ~15 lines |
| [`examples/gather-lite`](examples/gather-lite) | A tiny Gather-style world: walking avatars, **proximity chat**, emotes, a shared door — every event an onchain transaction |

## Run it

```bash
pnpm install

# demo against devnet (uses the deployed program)
pnpm --filter @solsocket/cursor-canvas dev
# open http://localhost:5173, fund the burner (~0.01 devnet SOL), move your
# mouse, open the invite link in a second window.

# the flagship demo: a multiplayer world
pnpm --filter @solsocket/gather-lite dev

# full local stack (base validator + ephemeral rollup)
npm i -g @magicblock-labs/ephemeral-validator
./scripts/local-stack.sh                          # terminal 1
pnpm --filter @solsocket/program test:local       # program lifecycle tests
pnpm --filter solsocket test:local                # SDK two-client e2e tests
```

Toolchain: Node ≥ 20, pnpm, and for program development Anchor **1.0.2** (avm),
Solana CLI 3.x, Rust 1.89+.

## API sketch

```ts
SolSocket.connect({ wallet, cluster: "devnet" | "local" | custom, session? })
sock.joinOrCreate<T>("name", opts?)  // named room: same name → same room
sock.createRoom<T>({ id?, maxPlayers?, initialState?, codec?, ... })  → Room
sock.joinRoom<T>(address)            // handles rejoin + lost-session recovery
room.broadcast(data)         // write own presence slot (fire-and-forget)
room.emit(name, data)        // ephemeral event in tx logs — no state write
room.setState(data)          // write shared room state
room.onPresence(cb)          // every player's updates, ~50ms
room.onMessage(name?, cb)    // emitted events, optionally filtered by name
room.onStateChange(cb)       // shared-state updates, ~50ms
room.getState()              // read from the ER
room.leave()                 // commit + undelegate own presence (session-signed)
room.closeToBase()           // creator: commit + undelegate the room
```

Helpers: `trackPresence(room, { onJoin, onUpdate, onLeave })` — roster with
staleness sweeping (no ghost avatars) — and `smoothPresence(room, render)` —
entity interpolation that turns 10Hz broadcasts into 60fps movement.

State, presence, and messages each take their own pluggable `Codec`
(`Room<TState, TPresence, TMessage>`): JSON by default, `structCodec` for
compact binary presence (a full avatar in ~20 bytes), `rawCodec` for bytes.

## Trust model

Be precise about what is and isn't enforced on-chain:

- **The program enforces**: room membership (you can only write presence,
  events, or shared state through a presence slot the program created for
  you), session authority (only the session key registered at join can sign
  as you — rejoining rotates it via a wallet-signed recovery), size caps on
  every payload, and creator-only room closure.
- **Clients self-report their own presence.** A position broadcast is
  client-authored, exactly like every mainstream game-netcode SDK
  (Socket.io, Colyseus, Photon) — solsocket makes movement *authenticated
  and attributable* (every update is a signed transaction from a known
  wallet), not *validated*. Game-rule enforcement (speed limits, collision)
  belongs in your program's instructions; the engine is deliberately
  game-agnostic.
- **Delegation trust follows MagicBlock's ER model**: while delegated, the
  regional ER validator sequences and executes writes; state commits back
  to the base layer on `leave()` / `closeToBase()`. Session keys live in
  localStorage and can only write realtime room data — they never hold or
  move funds; your wallet signs only the base-layer create/join/close.

## Status & roadmap

Built for [MagicBlock Solana Blitz v7](https://build.magicblock.app)
(theme: Collaboration). Working now: everything above, tested on the local
MagicBlock stack and Solana devnet (measured: 8ms cross-client event delivery
and 54ms presence delivery on a local ER). Next: room discovery (`listRooms`),
multi-region ER selection (`region: "asia" | "eu" | "us"`), mainnet.

## License

MIT © Pratik Kale
