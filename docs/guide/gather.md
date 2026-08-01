# Build a tiny Gather

[gather-lite](https://github.com/Pratikkale26/solsocket/tree/main/examples/gather-lite)
is a Gather-style world — walking avatars, proximity chat, emotes, a shared
door — where every movement, message, and interaction is an onchain
transaction. The whole realtime integration is about 40 lines. This guide walks
through them.

## 1. Design the presence payload

An avatar is position + facing + emote + name. As JSON that's ~70 bytes per
broadcast at 10Hz; as a binary struct it's ~23:

```ts
import { structCodec } from "solsocket";

interface Avatar {
  x: number; y: number;      // tile coords
  facing: number;            // 0-3
  emote: number;             // index into the emote table
  name: string;              // display name
}

const avatarCodec = structCodec<Avatar>([
  ["x", "u16"],
  ["y", "u16"],
  ["facing", "u8"],
  ["emote", "u8"],
  ["name", "string"],
]);
```

## 2. Create or join the world

The invite link carries the room address — and pins cluster and region, because
a room lives on the ER it was delegated to:

```ts
const sock = SolSocket.connect({ wallet, cluster, region });
const opts = { presenceCodec: avatarCodec, initialState: { door: false } };

const room = inviteAddress
  ? await sock.joinRoom<WorldState, Avatar, Msg>(new PublicKey(inviteAddress), opts)
  : await sock.createRoom<WorldState, Avatar, Msg>(opts);

history.replaceState(null, "", `?room=${room.address.toBase58()}&region=${region}`);
```

A lobby browser is one call — `listRooms()` returns every live world, busiest
first:

```ts
const worlds = (await sock.listRooms()).filter((r) => r.players > 0).slice(0, 4);
```

## 3. Movement: predict locally, broadcast at 10Hz, render at 60fps

Move your own avatar instantly on keypress (local prediction), and broadcast
the position ~10 times a second while moving. `smoothPresence` turns those
10Hz samples from other players into interpolated 60fps motion:

```ts
// in the input loop, throttled to ~10Hz while keys are held:
void room.broadcast({ x, y, facing, emote: 0, name });

// remote players: entity interpolation, no visible stutter
smoothPresence(room, (players) => { remotes = players; });
```

Broadcasts are fire-and-forget by default — the websocket subscription is the
source of truth, and round-trip echo (~50ms on a nearby region) is your proof
the write landed.

## 4. Proximity chat and emotes: events, not state

Chat doesn't belong in an account — it's ephemeral. `emit` writes an event into
transaction logs with no state write, and every client applies its own
proximity rule on receipt:

```ts
await room.emit("chat", { text });
room.onMessage("chat", ({ player, data }) => {
  if (distance(player) <= 4) showBubble(player, data.text); // heard within 4 tiles
});

await room.emit("emote", { kind: 2 });
room.onMessage("emote", ({ player, data }) => flashEmote(player, data.kind));
```

## 5. The shared door: room state

One object the whole room agrees on. Press E near the door:

```ts
await room.setState({ door: !doorOpen });
room.onStateChange(({ state }) => setDoorOpen(state.door));
```

## 6. Prove it's onchain

gather-lite keeps a writes counter and an explorer link on screen. Every
broadcast, chat bubble, and door toggle is a signed, fee-zero transaction on
the ER — and when the creator calls `closeToBase()`, the final world state is
an ordinary account on the base layer.

That's the entire integration: one codec, one join call, three channels, two
helpers. The rest of gather-lite is a tile map and a `<canvas>`.
