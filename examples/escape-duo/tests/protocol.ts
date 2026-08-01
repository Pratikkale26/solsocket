/* Two-client devnet protocol test for escape-duo. Replicates App.tsx's exact
 * state-sync logic (optimistic merge, retrying pushState, OR-merge +
 * reconciliation on receive) and drives the full vault sequence with
 * DELIBERATELY CONCURRENT writes from both players to prove the races
 * converge. Run from examples/escape-duo:
 *   NODE_OPTIONS="--require <dns-fix.js>" node --experimental-strip-types tests/protocol.ts
 * Needs a funded devnet keypair at $FUNDER_KEYPAIR to top up two burners.
 */
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { Room, SolSocket, structCodec } from "solsocket";

type Player = { x: number; y: number; facing: number; name: string };
type VaultState = {
  level: number;
  doors: number;
  keyA: number;
  keyB: number;
  start: number;
  run: number;
};
type Vault = Room<VaultState, Player, { text: string }>;

const playerCodec = structCodec<Player>([
  ["x", "u16"],
  ["y", "u16"],
  ["facing", "u8"],
  ["name", "string"],
]);
const vaultCodec = structCodec<VaultState>([
  ["level", "u8"],
  ["doors", "u8"],
  ["keyA", "f64"],
  ["keyB", "f64"],
  ["start", "f64"],
  ["run", "f64"],
]);
const DOOR1 = 1,
  LOCK1 = 2,
  LOCK2 = 4,
  LATCH = 8;
const escaped = (s: VaultState) =>
  s.keyA > 0 && s.keyB > 0 && Math.abs(s.keyA - s.keyB) <= 2_000;

/** Replica of App.tsx's state handling — keep in sync with the app. */
class Client {
  vault: VaultState = { level: 0, doors: 0, keyA: 0, keyB: 0, start: 0, run: 0 };
  myKeyAt = 0;
  label: string;
  room: Vault;
  myKey: "keyA" | "keyB";
  constructor(label: string, room: Vault, myKey: "keyA" | "keyB") {
    this.label = label;
    this.room = room;
    this.myKey = myKey;
    room.onStateChange(({ state }) => this.apply(state));
  }
  pushState(tries = 5) {
    this.room.setState({ ...this.vault }).catch(() => {
      if (tries > 1) setTimeout(() => this.pushState(tries - 1), 1_500);
    });
  }
  write(patch: Partial<VaultState>) {
    this.vault = { ...this.vault, ...patch };
    this.pushState();
  }
  apply(s: VaultState) {
    if (s.level > this.vault.level) {
      // partner advanced — follow into the next level
      this.vault = { ...s };
      this.myKeyAt = 0;
      return;
    }
    if (s.level < this.vault.level) {
      // chain behind our advance — push again
      this.pushState();
      return;
    }
    const merged = s.doors | this.vault.doors;
    const chainMissedBits = merged !== s.doors;
    this.vault = { ...s, doors: merged };
    if (this.myKeyAt > 0 && Date.now() - this.myKeyAt < 10_000 && this.vault[this.myKey] === 0) {
      this.write({ [this.myKey]: this.myKeyAt } as Partial<VaultState>);
      return;
    }
    if (chainMissedBits) this.pushState();
  }
  turnKey() {
    this.myKeyAt = Date.now();
    this.write({ [this.myKey]: this.myKeyAt } as Partial<VaultState>);
  }
  advance() {
    this.myKeyAt = 0;
    this.write({
      level: this.vault.level + 1,
      doors: 0,
      keyA: 0,
      keyB: 0,
      start: 0,
      run: this.vault.run,
    });
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (cond: boolean, msg: string) => {
  console.log(`${cond ? "  ✓" : "  ✗ FAIL"} ${msg}`);
  if (!cond) failures++;
};

async function main() {
  const funderPath =
    process.env.FUNDER_KEYPAIR ?? "/mnt/c/Users/Prati/Downloads/summit-devnet-keypair.json";
  const funder = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(funderPath, "utf8"))),
  );
  const walletA = Keypair.generate();
  const walletB = Keypair.generate();

  console.log("· funding two burners from", funder.publicKey.toBase58().slice(0, 8));
  const sockA = SolSocket.connect({ wallet: walletA, cluster: "devnet" });
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: funder.publicKey,
      toPubkey: walletA.publicKey,
      lamports: 0.02 * LAMPORTS_PER_SOL,
    }),
    SystemProgram.transfer({
      fromPubkey: funder.publicKey,
      toPubkey: walletB.publicKey,
      lamports: 0.02 * LAMPORTS_PER_SOL,
    }),
  );
  await sendAndConfirmTransaction(sockA.base, tx, [funder]);

  console.log("· A creates the vault (create + join + delegate, one tx)");
  const opts = { codec: vaultCodec, presenceCodec: playerCodec };
  const roomA = await sockA.createRoom<VaultState, Player, { text: string }>({
    ...opts,
    maxPlayers: 2,
    initialState: { level: 0, doors: 0, keyA: 0, keyB: 0, start: 0, run: 0 },
  });
  console.log("  vault:", roomA.address.toBase58());

  console.log("· B joins");
  const sockB = SolSocket.connect({ wallet: walletB, cluster: "devnet" });
  const roomB = await sockB.joinRoom<VaultState, Player, { text: string }>(
    new PublicKey(roomA.address),
    opts,
  );

  const A = new Client("A", roomA, "keyA");
  const B = new Client("B", roomB, "keyB");

  // ── presence both ways (the plates need each side to see the other) ──
  console.log("· presence exchange");
  const t0 = Date.now();
  const bSawA = new Promise<number>((res) => {
    roomB.onPresence(({ player }) => {
      if (player.equals(walletA.publicKey)) res(Date.now() - t0);
    });
  });
  const aSawB = new Promise<number>((res) => {
    roomA.onPresence(({ player }) => {
      if (player.equals(walletB.publicKey)) res(Date.now() - t0);
    });
  });
  // Like the app: keep broadcasting (10Hz loop + heartbeat) — a one-shot
  // send can race the peer's subscription coming up.
  const beat = setInterval(() => {
    void roomA.broadcast({ x: 84, y: 60, facing: 0, name: "tester-A" });
    void roomB.broadcast({ x: 84, y: 204, facing: 0, name: "tester-B" });
  }, 500);
  const [la, lb] = await Promise.all([
    Promise.race([bSawA, sleep(10_000).then(() => -1)]),
    Promise.race([aSawB, sleep(10_000).then(() => -1)]),
  ]);
  clearInterval(beat);
  check(la >= 0 && lb >= 0, `both saw each other (A→B ${la}ms, B→A ${lb}ms)`);

  // ── race 1: BOTH clients latch door 1 at the same instant ──
  console.log("· race: simultaneous DOOR1 latch");
  const start = Date.now();
  A.write({ doors: A.vault.doors | DOOR1, start, run: start });
  B.write({ doors: B.vault.doors | DOOR1, start, run: start });
  await sleep(4_000);
  check((A.vault.doors & DOOR1) !== 0 && (B.vault.doors & DOOR1) !== 0, "DOOR1 on both clients");

  // ── race 2: the clobber case — A writes LOCK2 while B writes LOCK1 ──
  console.log("· race: concurrent LOCK writes (classic lost-update)");
  A.write({ doors: A.vault.doors | LOCK2 });
  B.write({ doors: B.vault.doors | LOCK1 });
  await sleep(8_000); // reconciliation may need an extra round trip
  const both = DOOR1 | LOCK1 | LOCK2;
  check((A.vault.doors & both) === both, `A converged (doors=${A.vault.doors})`);
  check((B.vault.doors & both) === both, `B converged (doors=${B.vault.doors})`);
  const chain1 = await roomA.getState();
  check(((chain1?.state.doors ?? 0) & both) === both, `on-chain doors=${chain1?.state.doors}`);

  // ── latch, then race 3: both keys inside the 2s window ──
  console.log("· LATCH + concurrent key turns");
  B.write({ doors: B.vault.doors | LATCH });
  await sleep(2_000);
  A.turnKey();
  await sleep(300); // inside the window, but not the same slot
  B.turnKey();
  await sleep(6_000);
  check(escaped(A.vault), `A sees the escape (Δ ${Math.abs(A.vault.keyA - A.vault.keyB)}ms)`);
  check(escaped(B.vault), `B sees the escape (Δ ${Math.abs(B.vault.keyA - B.vault.keyB)}ms)`);
  const chain2 = await roomB.getState();
  check(escaped(chain2!.state), "escape is on-chain");
  check((chain2!.state.doors & LATCH) !== 0, "LATCH survived the key writes");

  // ── level advance: BOTH players hit "next level" at the same instant ──
  console.log("· race: simultaneous level advance");
  A.advance();
  B.advance();
  await sleep(6_000);
  check(A.vault.level === 1 && B.vault.level === 1, `both on level 1 (A=${A.vault.level} B=${B.vault.level})`);
  check(A.vault.doors === 0 && B.vault.doors === 0, "doors reset for the new level");
  check(A.vault.run === start, "run clock survives the level change");
  const chain3 = await roomA.getState();
  check(chain3?.state.level === 1 && chain3.state.doors === 0, "level advance is on-chain");
  // and progress works on the new level
  A.write({ doors: A.vault.doors | DOOR1, start: Date.now() });
  await sleep(4_000);
  check((B.vault.doors & DOOR1) !== 0 && B.vault.level === 1, "level-2 DOOR1 syncs to B");

  // ── cleanup: state commits back to the base layer ──
  console.log("· cleanup: leave + closeToBase");
  await roomB.leave();
  await roomA.closeToBase();
  console.log(failures === 0 ? "\nALL PROTOCOL CHECKS PASSED" : `\n${failures} FAILURES`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error("protocol test crashed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
