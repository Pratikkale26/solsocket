# Concepts

## The lifecycle: base layer → ephemeral rollup → base layer

Every solsocket room moves through three phases:

1. **Create + delegate (base layer, one wallet signature).** `createRoom` /
   `joinOrCreate` builds the room and presence accounts and delegates them to a
   [MagicBlock Ephemeral Rollup](https://docs.magicblock.gg) — all in a single
   transaction.
2. **Play (ephemeral rollup).** While delegated, all writes — presence
   broadcasts, events, shared state — execute on the ER: ~50ms slots, zero fees,
   signed by your session key. Subscriptions are `processed`-commitment
   websockets straight from the ER, so delivery is push, not confirm-polling.
3. **Commit + undelegate (base layer).** `leave()` commits your presence slot
   back; `closeToBase()` (creator only) commits the room. The session was
   ephemeral — the outcome is ordinary Solana state anyone can read or compose
   with.

## Rooms and presence are just accounts

The on-chain program (`solsocket-engine`) owns two account types, both PDAs:

- **Room** — creator, id, max players, a size-capped state blob, and a write
  sequence number.
- **Presence** — one per player per room: your session authority and your
  size-capped presence blob.

Because they're ordinary accounts, `listRooms()` is just `getProgramAccounts`
with discriminator filters, and any explorer can show your room's final state.

## Session keys

At connect, solsocket loads or creates a keypair in `localStorage`
(`loadOrCreateSession`). Joining a room registers it as your presence slot's
authority; from then on it signs every realtime write — so there are **no wallet
popups after join**.

Session keys never hold or move funds — ER transactions are fee-free, so the
key needs no SOL, ever. Your real wallet signs only the base-layer
create/join/close transactions. If localStorage is wiped, `joinRoom` detects the
lost session and rotates in a fresh key with one wallet-signed recovery
transaction.

## The three channels, and codecs

State, presence, and messages are independent channels with independent codecs
(`Room<TState, TPresence, TMessage>`):

| Channel | Write | Read | On chain as |
|---|---|---|---|
| Shared state | `setState` | `getState` / `onStateChange` | Room account data |
| Presence | `broadcast` | `onPresence` | Presence account data |
| Messages | `emit` | `onMessage` | Transaction logs (no state write) |

Codecs are pluggable: JSON by default, `structCodec` for compact binary structs
(a full game avatar fits in ~20 bytes), `rawCodec` for apps that manage their own
bytes.

## Presence helpers

Raw broadcasts arrive at whatever rate peers send them (10Hz is typical). Two
helpers turn that into something render-ready:

- **`trackPresence(room, { onJoin, onUpdate, onLeave })`** — a roster with
  staleness sweeping. Presence slots stay onchain when a tab closes without
  `leave()`; this keeps ghost avatars out of your world.
- **`smoothPresence(room, render)`** — entity interpolation: remote players
  render ~120ms in the past and lerp between samples, so 10Hz broadcasts look
  like 60fps movement.

## Regions

Devnet ERs run in three regions — `asia` (default), `eu`, `us`. Pick the one
closest to your players. Delegation pins a room to the region it was created
on, so every client joining that room must connect with the same `region`;
encode it in your invite links.

## Reconnection

- **Same session** (page refresh): rejoin resumes in ~1ms with zero base-layer
  transactions — the presence slot and session key are still valid.
- **Lost session** (cleared storage, new device): `joinRoom` recovers with one
  wallet-signed transaction that rotates the session authority, then waits for
  the ER to pick up the re-delegation before letting writes through.
