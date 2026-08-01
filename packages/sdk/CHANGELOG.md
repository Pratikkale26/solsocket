# Changelog

## 0.2.1 — 2026-08-02

### Added

- **`sock.peekState(address, codec?)`** — read any room's shared state
  without joining it: no transaction, no membership. Live rooms read from
  the ER, committed rooms fall through to the base layer. Powers
  leaderboards and lobby previews.
- **`sock.spectate(address, opts?)`** — a read-only `Room` wired to the
  same realtime subscriptions (state, presence, messages) with NO join
  transaction: no fees, no rent, the wallet never needs funding. Verified
  on devnet: a 0-lamport wallet watching a live room.

### Fixed

- A byte-identical resend (same payload, same cached blockhash — e.g. an
  idle presence heartbeat) was rejected as "already been processed" even
  though the first copy landed; `sendInstructions` now surfaces it as the
  success it is.

## 0.2.0 — 2026-08-01

### Added

- **Events API**: `room.emit(name, data)` / `room.onMessage(listener)` —
  zero-rent realtime messages carried in transaction logs on the ephemeral
  rollup (no account writes). `onMessage(name, listener)` overload filters by
  event name. Backed by a new no-write `emit_event` program instruction that
  enforces room membership.
- **Named rooms**: `sock.joinOrCreate(name, opts)` — deterministic room id
  from the name (`sha256(name)` first 8 bytes), so every client that asks for
  `"lobby"` lands in the same room; create races resolve to a join.
- **`structCodec`**: schema-based binary codec (`u8`–`f64`, `bool`,
  length-prefixed `string`) for compact presence payloads.
- **Presence helpers**: `trackPresence(room, handlers)` — join/update/leave
  lifecycle with staleness sweeping (no more ghost avatars), and
  `smoothPresence(room, render)` — entity interpolation that renders 10Hz
  broadcasts at 60fps.
- **Per-channel codecs**: `Room<TState, TPresence, TMessage>` — state,
  presence, and messages can each use their own codec (e.g. JSON state +
  binary presence).
- **Regions**: `connect({ region: "asia" | "eu" | "us" })` picks the devnet
  ER closest to your players (validator identity pinned per region).
- **Discovery**: `sock.listRooms()` — every room live on the cluster's ER,
  with player counts, most populated first. The lobby browser.

### Fixed

- Confirmed sends now surface on-chain failure instead of resolving
  silently (`confirmTransaction`'s error value was ignored).
- `leave()`, `closeToBase()`, and session recovery retry through the ER's
  clone-propagation window (a freshly (re)delegated account can transiently
  fail commit/undelegate instructions).
- Clear, actionable errors for the common first-run failures: unfunded
  wallet (with the exact address, balance, and amount needed), joining a
  nonexistent room (with a cluster hint), and ER-timeout on a
  cluster/region mismatch.
- Lost-session rejoin: the ER can serve a stale presence clone holding the
  old session authority for tens of seconds after re-delegation, silently
  dropping the recovered player's writes — `joinRoom` now waits until the
  clone carries the new session key. Same-session refresh still resumes
  instantly with zero base-layer transactions.

### Changed

- `Room` gains two more type parameters (defaulted, non-breaking for existing
  `Room<T>` usage).

## 0.1.1 — 2026-08-01

### Fixed

- Native Node ESM support: `import ... from "solsocket"` now works without a
  bundler. The ESM build ships explicit `.js` specifiers, a
  `{"type":"module"}` marker, an embedded IDL (no JSON import), and a CJS
  interop shim for `@coral-xyz/anchor` / `@solana/web3.js` named imports that
  also stays bundler-safe.
- Tarball no longer includes test artifacts; `prepublishOnly` guards future
  publishes with a fresh build.

## 0.1.0 — 2026-07-28

Initial release: `SolSocket.connect`, `createRoom` / `joinRoom`, shared room
state (`setState` / `onStateChange`), presence broadcasts (`broadcast` /
`onPresence`), session keys (no wallet popups), MagicBlock Ephemeral Rollup
delegation, `leave` / `close` lifecycle.
