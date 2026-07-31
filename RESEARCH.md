# RESEARCH.md — "Socket.io for Solana" (Blitz v7)

Research completed 2026-07-31. Verdict up front: **the SDK does not duplicate anything that exists, the layer is genuinely missing, and the lifecycle works end-to-end on devnet from this machine.** Details, verified versions, and gotchas below. Waiting on your go before scaffolding.

---

## 1. Does this already exist? — No (and the gap recently got wider)

- **BOLT is deprecated.** The repo README now opens with "Bolt has been deprecated and is no longer actively maintained… kept available for reference only" (last push 2026-05-28). It was an ECS framework anyway — Rust components/systems + a thin Anchor-style TS client (`@magicblock-labs/bolt-sdk` 0.2.4, ~7 downloads/week). No rooms, no broadcast, no subscription API. MagicBlock retreated to low-level primitives — that's our pitch.
- **`@magicblock-labs/ephemeral-rollups-sdk` (TS) is low-level tx helpers**: `ConnectionMagicRouter`, delegation PDA derivation, `GetCommitmentSignature`. Current version **0.16.2** (2026-07-23; also `ephemeral-rollups-kit` 0.16.2 for @solana/kit). The examples repo still pins **0.14.3** in package.json (Rust crate resolves to 0.16.2). Real DX today: two `AnchorProvider`s, two `Program` instances, hand-derived PDAs, hand-sequenced delegate→ER→commit→undelegate, raw `onAccountChange`. Nothing room-shaped.
- **Full @magicblock-labs npm sweep**: `ephemeral-validator` 0.13.18, `magicsvm` 0.1.1, `gum-sdk`/`gum-react-sdk` 3.0.10 (session keys), `soar-sdk` 0.1.23 (leaderboards), `mirage` 0.4.1, `magic-router-sdk` 1.0.10, `create-magicblock` 0.1.10 (scaffolder — check overlap before building our CLI). Nothing session/room/realtime-named in TS. Unity SDK has ER support but is C#-only.
- **Third-party**: `@snapshotsol/snap` 0.1.0 (pre-alpha "match authority runtime", heavyweight, ~5 dl/wk, not a room API), `@repla/magicblock-adapter` 0.1.3 (thin delegation binding for their L3), `@covenant-org/er-guard` 0.1.2 (undelegation watchdog — complementary). No hackathon project has shipped this layer.
- **RFP page** (docs.magicblock.gg → Request For Products) exists but the list is a client-rendered Notion DB — **open it in a browser before pitching**; a tooling submission fits its framing either way.

## 2. Lifecycle verified on devnet — all 7 tests green

Ran `counter/anchor` from [magicblock-engine-examples](https://github.com/magicblock-labs/magicblock-engine-examples) (repo renamed `anchor-counter` → `counter/anchor`; also has `session-keys`, `ephemeral-account-chats`, `crank-counter`, `private-counter` examples worth mining).

```
✔ Initialize counter on Solana        (4.4s, base)
✔ Increase counter on Solana          (5.3s, base)
✔ Delegate counter to ER              (5.4s, base)   5bj5Dxsd…
✔ Increase counter on ER              (8.6s e2e)     3yULQHRD…
✔ Commit counter state on ER → Solana (6.2s ER + 12.9s base finality)
✔ Increase counter on ER and commit   (5.6s)
✔ Increment and undelegate            (4.3s)         27DRX3y7…
```

**⚠️ The latency numbers are the product motivation.** The ER executes in ~50ms, but the naive Anchor flow (`confirmed` commitment + HTTP confirm polling) yields 4–8s *perceived* latency — the ER doesn't reliably emit `confirmed` WS notifications, so web3.js falls back to polling. The official demo app instead subscribes with **`processed`** commitment (fires at slot time, ~30–100ms). Our SDK's core value: default to processed-commitment WS subscriptions + optimistic local state so devs get the 50ms experience by default.

### Working toolchain (this machine)
| Tool | Version | Note |
|---|---|---|
| Node / npm / yarn | 24.10.0 / 11.18.0 / 1.22.22 | matches repo's stated 24.x |
| Rust | 1.96.1 | |
| Solana CLI | 3.1.10 (Agave) | repo states 3.1.9 — fine |
| anchor-cli | **1.0.2 via avm** (pinned in Anchor.toml) | see gotcha #1 |
| @coral-xyz/anchor (TS) | 0.32.1 (npm latest) | |
| @magicblock-labs/ephemeral-rollups-sdk | 0.14.3 (TS) / 0.16.2 (Rust crate) | 0.16.2 TS is out; consider it for our SDK |

### Delegation lifecycle (as implemented in `counter` example)
1. **Program side** (`ephemeral_rollups_sdk::anchor`): `#[ephemeral]` on the program module; `#[delegate]` context with `#[account(mut, del)]` on the PDA; `ctx.accounts.delegate_pda(payer, seeds, DelegateConfig { validator, .. })`. Commit/undelegate now use the **`MagicIntentBundleBuilder`** API (`.commit(&[accounts])` / `.commit_and_undelegate(&[accounts])` — newer than what most tutorials show). Call `account.exit(&crate::ID)?` before committing to serialize Anchor state.
2. **Client side**: base-layer tx `delegate()` passing the **validator identity as a remaining account** (devnet Asia: `MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57`; EU `MEUGG…`, US `MUS3h…`, TEE `MTEWG…`; localnet `mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev`). Wait ~3s for the ER to pick up the delegation, then send txs to the ER endpoint with the *same* program/IDL. Delegation program: `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh`. Detect delegation client-side: `accountInfo.owner !== programId`.
3. **Commit** returns an ER tx hash; `GetCommitmentSignature(txHash, erConnection)` resolves the corresponding base-layer signature (~13s to finality). **Undelegate** restores base-layer ownership.

### Endpoints
| Purpose | HTTP / WS |
|---|---|
| ER devnet (Asia/EU/US/TEE) | `https://devnet-{as,eu,us,tee}.magicblock.app` + `wss://` same host |
| Magic Router devnet | `https://devnet-router.magicblock.app` (+wss) — routes per-request via `getDelegationStatus`; extra methods `getRoutes`, `getBlockhashForAccounts` |
| Base layer | `https://api.devnet.solana.com` |

### Gotchas hit while reproducing (all load-bearing for the SDK)
1. **anchor-cli 1.1.2 silently breaks the flow**: it auto-runs keys-sync semantics on build (rewrote `declare_id!` to my local keypair) and its IDL output made `@coral-xyz/anchor` 0.32.1 fail account-resolution on `delegate` with web3.js's cryptic `Unknown action 'undefined'` preflight error. **Use avm + the repo's pinned 1.0.2.**
2. **The example programs' PDAs are global singletons** (`seeds=[b"counter"]`) on a shared devnet deployment — anyone can delegate the PDA out from under you. I deployed our own copy (`4vSu8ARu8BDRzjUsGSFKbtKK2tWJaT2LLVPc42YkPddE`, cost ~2.17 SOL rent; wallet `CnKHYoUJ…` now holds 2.87 SOL devnet). Our SDK's room PDAs must be keyed by creator+nonce, never global seeds.
3. **WSL2 DNS64 breaks Node fetch** here: the local resolver returns IPv6-only NAT64 answers (`64:ff9b::…`) for `api.devnet.solana.com` (and intermittently for `*.magicblock.app`); curl/Solana CLI cope, Node's undici doesn't. Workaround in repo: `scratchpad/dns-fix.js` preload pinning IPv4 (via `NODE_OPTIONS=--require …`). Machine-specific — do not bake into the SDK; document in README troubleshooting.
4. `remainingAccounts` for the validator is easy to forget and fails obscurely — SDK should own validator selection (region option, sane default).

## 3. Subscriptions (the `onStateChange` core)

- The ER validator (`magicblock-aperture` module) implements real Solana websockets: **`accountSubscribe`, `programSubscribe`, `logsSubscribe`, `signatureSubscribe`, `slotSubscribe`** (no `blockSubscribe`). Plain `connection.onAccountChange()` works.
- **Subscribe directly to the specific ER region, never through the Router WS** — a Router WS connection binds to whichever ER it picked at connect time; txs routed elsewhere never fire your callback. (Straight from the official demo-app comments.)
- **Use `processed` commitment on ER subscriptions** — `confirmed` notifications are unreliable; `processed` fires at ~50ms slot time.
- **Lazy cloning**: undelegated accounts don't exist on the ER until touched. Subscribing before delegation is fine (callback fires when the account materializes); to force-read, the demo app abuses `requestAirdrop(pda, 1)` to trigger a clone. SDK should handle the "account not there yet" state explicitly.
- Decode with the Anchor account coder — this is what our typed `onStateChange<T>` wraps.

## 4. Session keys / popup-free UX

- **ER txs are zero-fee** (validator sponsors; top-ups via base-layer `lamportsDelegatedTransferIx` if exhausted). So for popup-free play, **a plain ephemeral `Keypair` suffices when instructions aren't authority-gated** — the counter demo does exactly this. (It derives it as `Keypair.fromSeed(walletPubkey.toBytes())` — demo-grade, publicly derivable; ours should be random + localStorage.)
- Full session-keys stack exists when instructions must check the main wallet's authority: program `KeyspM2ssCJbqUhQ4k7sveSiY4WjnYsrXkC8oDbwde5`, Rust crate `session-keys` 3.1.1 (`#[session_auth_or(…)]` macro), TS `@magicblock-labs/gum-react-sdk` 3.0.10 (`useSessionKeyManager` → `createSession/revokeSession`). The examples repo has a `session-keys/` example to crib from.
- **SDK recommendation**: v1 uses plain ephemeral keypairs (rooms gate writes by player PDA membership, not wallet authority) — zero deps, zero popups; expose gum-sdk session tokens as an opt-in for authority-gated actions. This also keeps the demo to "connect wallet once, then pure real-time".

## 5. Implications for the SDK design (deltas to your spec)

1. **The wedge is real and demo-able**: naive flow = 4–8s perceived; our flow = ~50ms. The demo video should show this side-by-side.
2. Room = PDA keyed `[b"room", creator, nonce]`; `join()` = player PDA + auto-delegate; `broadcast()` = ER tx via ephemeral keypair; `onStateChange()` = `accountSubscribe(processed)` on the region ER + Anchor decode; `leave()/close()` = commit_and_undelegate. Program-side scaffold uses `#[ephemeral]`/`#[delegate]`/`MagicIntentBundleBuilder`.
3. Pin the toolchain hard in the scaffold (anchor 1.0.2 via avm, `@coral-xyz/anchor` 0.32.1, ER SDK — decide 0.14.3-as-examples vs 0.16.2-latest; I'd try 0.16.2 TS first since the Rust side already resolves 0.16.2 and `ConnectionMagicRouter` lives there).
4. `ephemeral-account-chats` example (profiles + conversations + append message + delegate/undelegate) is the closest official thing to our data model — mine it before writing the Anchor scaffold.
5. Name-check `create-magicblock` (their official scaffolder) so our CLI story is "rooms SDK + scaffold", not a competing create-app.

**Open question for you**: target `@solana/web3.js` (what all examples use) or `@solana/kit` (`ephemeral-rollups-kit`)? I'd say web3.js for hackathon speed and ecosystem familiarity — kit adapter post-hackathon.

---

*Devnet artifacts from this session: program `4vSu8ARu…` (deployed, upgrade authority = `CnKHYoUJ…` wallet), counter PDA `6sxyscBz…` (undelegated at end of test run). Local repo: `magicblock-engine-examples/` (gitignore it or delete before scaffolding the monorepo).*
