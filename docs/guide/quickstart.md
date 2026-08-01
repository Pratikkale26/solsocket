# Quickstart

## Scaffold an app

The fastest start is the template — a working shared-cursor app with burner-wallet
onboarding already wired:

```bash
npm create solsocket my-app
cd my-app && npm install && npm run dev
```

Or add the SDK to an existing project:

```bash
npm install solsocket
```

## Connect

```ts
import { SolSocket } from "solsocket";

const sock = SolSocket.connect({
  wallet,            // wallet adapter (browser) or Keypair (node)
  cluster: "devnet", // "devnet" (default), "local", or { rpc, er } endpoints
  region: "eu",      // devnet ER region: "asia" (default) | "eu" | "us"
});
```

The wallet signs **one** base-layer transaction (create/join + delegate) and needs a
little devnet SOL for it — get some at [faucet.solana.com](https://faucet.solana.com).
Everything after that is signed by an auto-managed session key and costs nothing.

::: tip Regions
A room lives on the region it was created on. Everyone joining it must connect
with the same `region` — put it in your invite links.
:::

## Join a room

```ts
// Named room: every client asking for "lobby" lands in the same room
const room = await sock.joinOrCreate("lobby");

// Or explicitly:
const created = await sock.createRoom({ maxPlayers: 8 });
const joined = await sock.joinRoom(address); // from an invite link or listRooms()
```

## The three channels

Every room gives you three independent realtime channels:

```ts
// 1. Presence — your per-player slot (cursor, avatar, …). Fire-and-forget, ~50ms.
await room.broadcast({ x: 0.4, y: 0.7 });
room.onPresence(({ player, data }) => draw(player, data));

// 2. Messages — ephemeral events in transaction logs. No state write.
await room.emit("chat", { text: "gm" });
room.onMessage("chat", ({ player, data }) => bubble(player, data));

// 3. Shared state — one account the whole room reads and writes.
await room.setState({ doorOpen: true });
room.onStateChange(({ state }) => setDoor(state.doorOpen));
```

## Leave

```ts
await room.leave();       // commit + undelegate your presence slot
await room.closeToBase(); // creator only: commit + undelegate the room itself
```

After `leave()`/`closeToBase()` the accounts are back on the base layer — inspect
them on any explorer.

## Discover live rooms

```ts
const rooms = await sock.listRooms(); // busiest first
for (const r of rooms) console.log(r.address.toBase58(), `${r.players} players`);
```

## Run against a local stack

The repo ships `scripts/local-stack.sh`, which boots a local validator plus a local
ephemeral rollup. Connect with `cluster: "local"` — useful for tests and offline dev.

Next: [Concepts](/guide/concepts) for how it works under the hood, or
[Build a tiny Gather](/guide/gather) for the full walkthrough.
