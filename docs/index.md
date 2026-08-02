---
layout: home

hero:
  name: solsocket
  text: Socket.io for Solana
  tagline: Realtime multiplayer rooms — fully onchain, powered by MagicBlock Ephemeral Rollups. ~50ms writes, zero fees, one wallet signature.
  image:
    src: /logo.svg
    alt: solsocket
  actions:
    - theme: brand
      text: Quickstart
      link: /guide/quickstart
    - theme: alt
      text: GitHub
      link: https://github.com/Pratikkale26/solsocket

features:
  - icon: ⚡
    title: ~50ms, zero-fee writes
    details: Presence, events, and shared state run on an ephemeral rollup — measured 54ms cross-client delivery, fee = 0 on every realtime transaction.
  - icon: ✍️
    title: One signature, then flow
    details: A single wallet transaction creates, joins, and delegates a room. After that an auto-managed session key signs everything — no popups, ever.
  - icon: 🧱
    title: Real Solana state
    details: Rooms and presence are ordinary accounts. Leave or close and the state commits back to the base layer, permanent and composable.
  - icon: 🧰
    title: The Socket.io mental model
    details: joinOrCreate, broadcast, emit/onMessage, listRooms — plus interpolation and roster helpers so 10Hz broadcasts render as 60fps movement.
---

## Fifteen lines to multiplayer

```ts
import { SolSocket } from "solsocket";

const sock = SolSocket.connect({ wallet, cluster: "devnet", region: "eu" });
const room = await sock.joinOrCreate("lobby"); // same name → same room

room.onPresence(({ player, data }) => drawCursor(player, data)); // ~50ms
await room.broadcast({ x: 0.4, y: 0.7 }); // zero-fee, no wallet popup

room.onMessage("chat", ({ player, data }) => bubble(player, data));
await room.emit("chat", { text: "gm" }); // event in tx logs — no state write
```

```bash
npm create solsocket   # scaffold a working shared-cursor app
```
