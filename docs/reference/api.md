# API reference

Everything ships from the package root:

```ts
import { SolSocket, structCodec, trackPresence, smoothPresence } from "solsocket";
```

## `SolSocket.connect(options)`

Returns a `SolSocket` client. Synchronous — no network traffic until you join.

```ts
interface ConnectOptions {
  wallet: WalletLike | Keypair; // wallet adapter (browser) or Keypair (node); signs base-layer txs only
  cluster?: "devnet" | "local" | ClusterConfig; // default "devnet"
  region?: "asia" | "eu" | "us"; // devnet ER region, default "asia"
  session?: Keypair;            // override the auto-managed session key
}
```

`ClusterConfig` lets you point at custom endpoints (e.g. your own RPC + ER).
`region` only applies to the `"devnet"` cluster.

## Client methods

### `sock.joinOrCreate<T, P, M>(name, opts?)`

Named room: the room id is derived from `sha256(name)`, so every client asking
for `"lobby"` lands in the same room. Creates it (one wallet signature) if it
doesn't exist, joins it otherwise.

```ts
interface JoinOrCreateOptions<T, P = T, M = unknown> extends CreateRoomOptions {
  creator?: PublicKey; // whose named room — defaults to this wallet
}
```

### `sock.createRoom<T, P, M>(opts?)`

Create + join + delegate in a single base-layer transaction. Resolves to a
`Room<T, P, M>` already live on the ER.

```ts
interface CreateRoomOptions<T, P = T, M = unknown> {
  id?: number | BN;     // unique per creator; random by default
  maxPlayers?: number;
  initialState?: T;
  codec?: Codec<T>;          // shared-state codec (default JSON)
  presenceCodec?: Codec<P>;  // broadcast/onPresence codec (default: state codec)
  messageCodec?: Codec<M>;   // emit/onMessage codec (default JSON)
}
```

### `sock.joinRoom<T, P, M>(address, opts?)`

Join an existing room by address. Handles same-session rejoin (~1ms, zero base
txs) and lost-session recovery (one wallet-signed authority rotation)
automatically. Throws a descriptive error if no room exists at the address on
this cluster.

### `sock.listRooms()`

Every room currently live on the ER, sorted busiest-first.

```ts
interface RoomListing {
  address: PublicKey; // pass to joinRoom
  creator: PublicKey;
  id: BN;
  maxPlayers: number;
  players: number;    // players holding a presence slot (includes idle ones)
  seq: number;        // total state writes — an activity proxy
}
```

## `Room<TState, TPresence, TMessage>`

### Writes (session-signed, zero-fee, on the ER)

| Method | Does |
|---|---|
| `broadcast(data, opts?)` | Write your presence slot. Fire-and-forget by default; pass `{ confirm: true }` to await `processed` confirmation. |
| `emit(name, data)` | Ephemeral event in transaction logs — chat, hits, reactions. No state write. |
| `setState(data)` | Write the shared room state. |

### Reads & subscriptions

| Method | Payload |
|---|---|
| `onPresence(cb)` | `{ player: PublicKey, data: TPresence, seq: number }` |
| `onStateChange(cb)` | `{ state: TState, seq: number }` |
| `onMessage(name, cb)` / `onMessage(cb)` | `{ player, name, data: TMessage, signature }` |
| `getState()` | current `{ state, seq }` from the ER |

All subscriptions return an unsubscribe function.

### Leaving

| Method | Does |
|---|---|
| `leave()` | Commit + undelegate your presence slot (session-signed). |
| `closeToBase()` | Creator only: commit + undelegate the room itself. |

Both retry through the ER's delegation-propagation window automatically.

## Codecs

```ts
interface Codec<T> {
  encode(value: T): Uint8Array;
  decode(bytes: Uint8Array): T;
}
```

- `jsonCodec<T>()` — the default.
- `structCodec<T>(fields)` — compact binary structs. Borsh-style wire format:
  little-endian numbers, bool as one byte, string as u32 length + UTF-8. Field
  types: `u8 i8 u16 i16 u32 i32 f32 f64 bool string`.
- `rawCodec` — pass-through for apps that manage their own bytes.

```ts
const codec = structCodec<Avatar>([["x", "u16"], ["y", "u16"], ["name", "string"]]);
```

## Presence helpers

### `trackPresence(room, options)`

Roster with staleness sweeping — keeps ghost avatars (tabs closed without
`leave()`) out of your world. Returns `{ players, stop() }` — a live roster
map keyed by player pubkey, and a disposer.

```ts
interface TrackPresenceOptions<T> {
  staleMs?: number; // drop players silent this long (default 5000)
  sweepMs?: number; // sweep interval (default 1000)
  onJoin?: (entry: PresenceEntry<T>) => void;
  onUpdate?: (entry: PresenceEntry<T>) => void;
  onLeave?: (player: PublicKey) => void;
}
```

### `smoothPresence(room, render, options?)`

Entity interpolation: remote players render slightly in the past and lerp
between samples, so 10Hz broadcasts look like 60fps movement.

```ts
interface SmoothPresenceOptions {
  hz?: number;      // render callback rate (default 60)
  delayMs?: number; // interpolation delay (default 120)
  staleMs?: number; // drop players silent this long (default 5000)
}
```

## Lower-level exports

| Export | What |
|---|---|
| `PROGRAM_ID` | the `solsocket-engine` program id ([`CrLS…LeYh`](https://explorer.solana.com/address/CrLS1Ry58q59AgmqbNVrqbfs2bWGJtjk12PezXh4LeYh?cluster=devnet) on devnet) |
| `roomPda(creator, id)` / `presencePda(room, wallet)` | PDA derivation |
| `nameToRoomId(name)` | first 8 bytes of `sha256(name)` as a room id |
| `loadOrCreateSession(storageKey?)` | the localStorage session keypair |
| `resolveCluster(cluster, region?)`, `DEVNET`, `LOCAL` | endpoint resolution |
