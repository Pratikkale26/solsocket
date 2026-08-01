# Trust model

Be precise about what is and isn't enforced on-chain.

## What the program enforces

- **Room membership** — you can only write presence, events, or shared state
  through a presence slot the program created for you.
- **Session authority** — only the session key registered at join can sign as
  you; rejoining rotates it via a wallet-signed recovery.
- **Size caps** on every payload.
- **Creator-only room closure.**

## Clients self-report their own presence

A position broadcast is client-authored, exactly like every mainstream
game-netcode SDK (Socket.io, Colyseus, Photon). solsocket makes movement
**authenticated and attributable** — every update is a signed transaction from a
known wallet — not **validated**. Game-rule enforcement (speed limits,
collision) belongs in your program's instructions; the engine is deliberately
game-agnostic. Program-side validation hooks are on the roadmap.

## Delegation follows MagicBlock's ER model

While a room is delegated, the regional ER validator sequences and executes
writes; state commits back to the base layer on `leave()` / `closeToBase()`.
See [MagicBlock's docs](https://docs.magicblock.gg) for the delegation program's
own guarantees.

## Session keys never hold funds

The session key in localStorage can only write realtime room data. ER
transactions are fee-free, so it is never funded — an attacker who steals it can
scribble on your presence until you rejoin (which rotates it), and nothing more.
Your wallet signs only the base-layer create/join/close transactions.

## Everything is public

Room state, presence, and events are readable by anyone — including spectators
you never invited. Hidden-information games (poker hands, sealed bids) need
MagicBlock's TEE-based private ERs, which solsocket does not integrate yet.
