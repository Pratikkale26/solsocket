# Changelog

## Unreleased (0.2.0)

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
