# Blitz v7 submission guide

Working checklist for the Solana Blitz v7 submission (deadline **Sun Aug 9, ~9:30pm IST**).

## Ship checklist

- [ ] **Vercel**: `cd examples/cursor-canvas && npx vercel` (config is in `vercel.json`;
      set root directory to `examples/cursor-canvas` if the dashboard asks). Put the
      live URL in the README hero.
- [ ] **npm publish** (from repo root, needs `npm login`):
      `pnpm --filter solsocket build && cd packages/sdk && npm publish` then
      `cd ../create-solsocket && npm publish`. Order matters — the CLI template
      depends on `solsocket@^0.1.0` existing.
- [ ] **Record demo video** (script below), upload unlisted YouTube or attach mp4.
- [ ] **Submit** at hackathon.magicblock.app / the Luma form: repo link, live link,
      video, one-paragraph description.
- [ ] Optional: post on X during event week tagging @magicblock — past editions
      amplified builder posts.

## Demo video script (~2 min)

1. **Hook (0:00–0:20)** — README hero on screen. "Real-time multiplayer on Solana
   is a solved infrastructure problem — MagicBlock's ephemeral rollups run at 50ms
   slots — but the developer experience isn't. This is solsocket: Socket.io for
   Solana."
2. **The code (0:20–0:50)** — open `examples/cursor-canvas/src/App.tsx`, show the
   marked ~15-line block. "connect, createRoom, onPresence, broadcast. That's the
   entire integration. One wallet signature; after that every write is a zero-fee
   transaction signed by a session key."
3. **The demo (0:50–1:30)** — two (or four!) tiled browser windows on the Vercel
   link. Move the cursor, point at the sync. Open the explorer on the room account:
   "every one of these cursor positions is a Solana transaction on an ephemeral
   rollup — here's the account on-chain."
4. **The depth (1:30–1:50)** — flash the lifecycle test output: 9 program tests +
   5 SDK e2e tests, 54ms cross-client delivery, commit/undelegate back to base
   layer. "State isn't trapped: rooms commit back to Solana devnet."
5. **Close (1:50–2:00)** — `npm create solsocket my-app`. "Realtime onchain
   multiplayer, npm-installable today. Built during Blitz v7."

**Capture tips**: side-by-side windows, visible mouse; record at 1080p+; keep the
explorer tab pre-loaded; if latency spikes on hotel wifi, mention the local-stack
numbers instead of hiding it.

## Submission blurb (paste-ready)

> **solsocket — Socket.io for Solana.** A TypeScript SDK that makes realtime
> multiplayer on MagicBlock Ephemeral Rollups as easy as `createRoom()` /
> `broadcast()` / `onStateChange()`. One wallet signature creates, joins, and
> delegates a room; every message after that is a zero-fee, session-key-signed ER
> transaction delivered to other clients over websockets in ~50ms. Ships with an
> Anchor room-engine program (deployed on devnet), a two-client test suite
> measuring 54ms cross-client delivery, a shared-cursor demo app, and a
> `create-solsocket` scaffolder. BOLT is deprecated — solsocket is the missing
> high-level multiplayer layer for web devs. MIT.
