import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import assert from "node:assert/strict";
import { LOCAL, SolSocket, structCodec, trackPresence } from "../src";

type Cursor = { x: number; y: number };

describe("structCodec", () => {
  it("roundtrips a compact avatar struct", () => {
    type Avatar = { x: number; y: number; facing: number; live: boolean; name: string };
    const codec = structCodec<Avatar>([
      ["x", "u16"],
      ["y", "u16"],
      ["facing", "u8"],
      ["live", "bool"],
      ["name", "string"],
    ]);
    const avatar = { x: 420, y: 69, facing: 3, live: true, name: "pratik" };
    const bytes = codec.encode(avatar);
    assert.equal(bytes.length, 2 + 2 + 1 + 1 + 4 + 6); // 16B vs ~60B as JSON
    assert.deepEqual(codec.decode(bytes), avatar);
  });
});

describe("solsocket e2e: two clients, one room", () => {
  const alice = Keypair.generate();
  const bob = Keypair.generate();

  // Two independent clients in one process: give each its own session key
  // (the browser default of one localStorage session per tab does this for free).
  const sockA = SolSocket.connect({
    wallet: alice,
    cluster: "local",
    session: Keypair.generate(),
  });
  const sockB = SolSocket.connect({
    wallet: bob,
    cluster: "local",
    session: Keypair.generate(),
  });

  before(async function () {
    this.timeout(60_000);
    const faucet = new Connection(LOCAL.baseRpc, "confirmed");
    for (const kp of [alice, bob]) {
      const sig = await faucet.requestAirdrop(kp.publicKey, 5 * LAMPORTS_PER_SOL);
      await faucet.confirmTransaction(sig, "confirmed");
    }
  });

  let roomA: Awaited<ReturnType<typeof sockA.createRoom<Cursor>>>;
  let roomB: Awaited<ReturnType<typeof sockB.joinRoom<Cursor>>>;

  it("alice creates a room (one tx, live on the ER)", async () => {
    const t0 = Date.now();
    roomA = await sockA.createRoom<Cursor>({ initialState: { x: 0, y: 0 } });
    console.log(`createRoom -> ER-live in ${Date.now() - t0}ms`);
    const state = await roomA.getState();
    assert.deepEqual(state?.state, { x: 0, y: 0 });
  });

  it("bob joins the room", async () => {
    const t0 = Date.now();
    roomB = await sockB.joinRoom<Cursor>(roomA.address);
    console.log(`joinRoom -> ER-live in ${Date.now() - t0}ms`);
  });

  it("bob sees alice's broadcast via presence subscription", async () => {
    const received: { from: string; data: Cursor; ms: number }[] = [];
    let t0 = Date.now();
    const unsub = roomB.onPresence(({ player, data }) => {
      received.push({ from: player.toBase58(), data, ms: Date.now() - t0 });
    });
    // Give the websocket subscription a beat to be registered server-side.
    await new Promise((r) => setTimeout(r, 500));

    t0 = Date.now();
    await roomA.broadcast({ x: 42, y: 7 });
    for (let i = 0; i < 40 && received.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    unsub();
    assert.ok(received.length > 0, "presence update should arrive over WS");
    const hit = received.find((r) => r.from === alice.publicKey.toBase58());
    assert.ok(hit, "update should be attributed to alice's wallet");
    assert.deepEqual(hit!.data, { x: 42, y: 7 });
    console.log(`broadcast -> remote WS delivery in ${hit!.ms}ms`);
  });

  it("bob hears alice's ephemeral message via emit/onMessage", async () => {
    const received: { from: string; text: string; ms: number }[] = [];
    let t0 = Date.now();
    const unsub = roomB.onMessage("chat", ({ player, data }) => {
      received.push({
        from: player.toBase58(),
        text: (data as { text: string }).text,
        ms: Date.now() - t0,
      });
    });
    await new Promise((r) => setTimeout(r, 500));

    t0 = Date.now();
    await roomA.emit("chat", { text: "gm from alice" });
    for (let i = 0; i < 40 && received.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    unsub();
    assert.ok(received.length > 0, "message should arrive over the log subscription");
    const hit = received.find((r) => r.from === alice.publicKey.toBase58());
    assert.ok(hit, "message should be attributed to alice's wallet");
    assert.equal(hit!.text, "gm from alice");
    console.log(`emit -> remote WS delivery in ${hit!.ms}ms`);
  });

  it("named onMessage filters out other events", async () => {
    const chatHits: string[] = [];
    const allHits: string[] = [];
    const unsubChat = roomB.onMessage("chat", ({ name }) => chatHits.push(name));
    const unsubAll = roomB.onMessage(({ name }) => allHits.push(name));
    await new Promise((r) => setTimeout(r, 500));

    await roomA.emit("emote", { kind: "wave" });
    for (let i = 0; i < 40 && allHits.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    unsubChat();
    unsubAll();
    assert.ok(allHits.includes("emote"), "unfiltered listener hears the emote");
    assert.equal(chatHits.length, 0, "'chat' listener must not hear an 'emote'");
  });

  it("alice sees bob's shared-state write", async () => {
    const received: { data: Cursor; seq: number }[] = [];
    const unsub = roomA.onStateChange(({ state, seq }) => {
      received.push({ data: state, seq });
    });
    await new Promise((r) => setTimeout(r, 500));

    await roomB.setState({ x: 9, y: 9 });
    for (let i = 0; i < 40 && received.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    unsub();
    assert.ok(received.length > 0, "state update should arrive over WS");
    assert.deepEqual(received[received.length - 1].data, { x: 9, y: 9 });
  });

  it("trackPresence: join and stale-leave lifecycle (ghost-avatar fix)", async function () {
    this.timeout(20_000);
    const joins: string[] = [];
    const leaves: string[] = [];
    const tracker = trackPresence(roomB, {
      staleMs: 1_500,
      sweepMs: 200,
      onJoin: (e) => joins.push(e.player.toBase58()),
      onLeave: (p) => leaves.push(p.toBase58()),
    });
    await new Promise((r) => setTimeout(r, 500));

    await roomA.broadcast({ x: 5, y: 5 });
    for (let i = 0; i < 40 && joins.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(joins.includes(alice.publicKey.toBase58()), "join fires on first update");

    // Alice goes silent (tab closed without leave()): the sweep drops her.
    for (let i = 0; i < 40 && leaves.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    tracker.stop();
    assert.ok(leaves.includes(alice.publicKey.toBase58()), "stale player leaves");
    assert.equal(tracker.players.size, 0);
  });

  it("split codecs: JSON room state + binary struct presence", async function () {
    this.timeout(60_000);
    type Avatar = { x: number; y: number; facing: number };
    const avatarCodec = structCodec<Avatar>([
      ["x", "u16"],
      ["y", "u16"],
      ["facing", "u8"],
    ]);
    const name = `codec-${Date.now()}`;
    const a = await sockA.joinOrCreate<{ door: boolean }, Avatar>(name, {
      initialState: { door: false },
      presenceCodec: avatarCodec,
    });
    const b = await sockB.joinOrCreate<{ door: boolean }, Avatar>(name, {
      creator: alice.publicKey,
      presenceCodec: avatarCodec,
    });

    const seen: Avatar[] = [];
    const unsub = b.onPresence(({ player, data }) => {
      if (player.equals(alice.publicKey)) seen.push(data);
    });
    await new Promise((r) => setTimeout(r, 500));
    await a.broadcast({ x: 123, y: 456, facing: 2 });
    for (let i = 0; i < 40 && seen.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    unsub();
    assert.deepEqual(seen[0], { x: 123, y: 456, facing: 2 });
    assert.deepEqual((await b.getState())?.state, { door: false });
    await b.leave();
    await a.closeToBase();
  });

  it("joinOrCreate: same name lands both clients in the same room", async function () {
    this.timeout(60_000);
    const name = `lobby-${Date.now()}`;
    const lobbyA = await sockA.joinOrCreate<Cursor>(name);
    const lobbyB = await sockB.joinOrCreate<Cursor>(name, {
      creator: alice.publicKey,
    });
    assert.equal(lobbyA.address.toBase58(), lobbyB.address.toBase58());
    assert.equal(
      lobbyA.address.toBase58(),
      sockB.roomAddressForName(alice.publicKey, name).toBase58(),
    );
    await lobbyB.leave();
    await lobbyA.closeToBase();
  });

  it("bob leaves; alice closes the room to the base layer", async function () {
    this.timeout(120_000);
    await roomB.leave();
    await roomA.closeToBase();
    const base = new Connection(LOCAL.baseRpc, "confirmed");
    for (let i = 0; i < 60; i++) {
      const info = await base.getAccountInfo(roomA.address);
      if (info && !info.owner.toBase58().startsWith("DELeG")) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    const info = await base.getAccountInfo(roomA.address);
    assert.ok(info, "room survives on the base layer");
  });
});
