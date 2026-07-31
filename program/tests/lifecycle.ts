import * as anchor from "@coral-xyz/anchor";
import { Program, web3 } from "@coral-xyz/anchor";
import assert from "node:assert/strict";
import type { SolsocketEngine } from "../target/types/solsocket_engine";
import { GetCommitmentSignature } from "@magicblock-labs/ephemeral-rollups-sdk";

const ROOM_SEED = "room";
const PRESENCE_SEED = "presence";
const DELEGATION_PROGRAM = new web3.PublicKey(
  "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh",
);

describe("solsocket-engine lifecycle", () => {
  const base = new anchor.AnchorProvider(
    new web3.Connection(process.env.PROVIDER_ENDPOINT || "http://localhost:8899", {
      wsEndpoint: process.env.WS_ENDPOINT || "ws://localhost:8900",
      commitment: "confirmed",
    }),
    anchor.Wallet.local(),
  );
  anchor.setProvider(base);

  // ER connection runs at `processed`: the ER doesn't reliably emit `confirmed`
  // websocket notifications, while `processed` fires at slot time (~50ms).
  const erConnection = new web3.Connection(
    process.env.EPHEMERAL_PROVIDER_ENDPOINT || "http://localhost:7799",
    {
      wsEndpoint: process.env.EPHEMERAL_WS_ENDPOINT || "ws://localhost:7800",
      commitment: "processed",
    },
  );

  const wallet = anchor.Wallet.local();
  const session = web3.Keypair.generate();
  const erSession = new anchor.AnchorProvider(erConnection, new anchor.Wallet(session), {
    commitment: "processed",
    skipPreflight: true,
  });
  const erWallet = new anchor.AnchorProvider(erConnection, wallet, {
    commitment: "processed",
    skipPreflight: true,
  });

  const program = anchor.workspace.SolsocketEngine as Program<SolsocketEngine>;
  const programErSession = new Program<SolsocketEngine>(program.idl, erSession);
  const programErWallet = new Program<SolsocketEngine>(program.idl, erWallet);

  const roomId = new anchor.BN(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));
  const [roomPda] = web3.PublicKey.findProgramAddressSync(
    [
      Buffer.from(ROOM_SEED),
      wallet.publicKey.toBuffer(),
      roomId.toArrayLike(Buffer, "le", 8),
    ],
    program.programId,
  );
  const [presencePda] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from(PRESENCE_SEED), roomPda.toBuffer(), wallet.publicKey.toBuffer()],
    program.programId,
  );
  const validator = new web3.PublicKey(
    process.env.VALIDATOR || "mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev",
  );

  console.log("Base layer:", base.connection.rpcEndpoint);
  console.log("Ephemeral rollup:", erConnection.rpcEndpoint);
  console.log("Wallet:", wallet.publicKey.toBase58());
  console.log("Session key:", session.publicKey.toBase58());
  console.log("Room PDA:", roomPda.toBase58());

  before(async () => {
    const isLocal = base.connection.rpcEndpoint.includes("localhost");
    const balance = await base.connection.getBalance(wallet.publicKey);
    if (isLocal && balance < web3.LAMPORTS_PER_SOL) {
      const sig = await base.connection.requestAirdrop(
        wallet.publicKey,
        5 * web3.LAMPORTS_PER_SOL,
      );
      await base.connection.confirmTransaction(sig, "confirmed");
    }
    console.log(
      "Balance:",
      (await base.connection.getBalance(wallet.publicKey)) / web3.LAMPORTS_PER_SOL,
      "SOL",
    );
  });

  it("creates a room on the base layer", async () => {
    await program.methods
      .createRoom(roomId, 8, Buffer.from([]))
      .accounts({ creator: wallet.publicKey })
      .rpc({ skipPreflight: true });
    const room = await program.account.room.fetch(roomPda);
    assert.equal(room.roomId.toString(), roomId.toString());
    assert.equal(room.seq.toNumber(), 0);
  });

  it("joins the room, registering the session authority", async () => {
    await program.methods
      .joinRoom(session.publicKey)
      .accounts({ room: roomPda, player: wallet.publicKey })
      .rpc({ skipPreflight: true });
    const presence = await program.account.presence.fetch(presencePda);
    assert.equal(presence.authority.toBase58(), session.publicKey.toBase58());
    assert.equal(presence.room.toBase58(), roomPda.toBase58());
  });

  it("delegates room + presence to the ER in one transaction", async () => {
    const remainingAccounts = [
      { pubkey: validator, isSigner: false, isWritable: false },
    ];
    const delegateRoomIx = await program.methods
      .delegateRoom(wallet.publicKey, roomId)
      .accounts({ payer: wallet.publicKey, pda: roomPda })
      .remainingAccounts(remainingAccounts)
      .instruction();
    const delegatePresenceIx = await program.methods
      .delegatePresence(roomPda, wallet.publicKey)
      .accounts({ payer: wallet.publicKey, pda: presencePda })
      .remainingAccounts(remainingAccounts)
      .instruction();
    const tx = new web3.Transaction().add(delegateRoomIx, delegatePresenceIx);
    await base.sendAndConfirm(tx, [wallet.payer], {
      skipPreflight: true,
      commitment: "confirmed",
    });

    const roomInfo = await base.connection.getAccountInfo(roomPda);
    assert.ok(roomInfo, "room account must exist");
    assert.equal(
      roomInfo.owner.toBase58(),
      DELEGATION_PROGRAM.toBase58(),
      "room should be owned by the delegation program after delegating",
    );
    // Give the ER a moment to pick up the delegation before writing to it.
    await new Promise((r) => setTimeout(r, 3000));
  });

  it("writes shared state on the ER with the session key and sees it via WS", async () => {
    const payload = Buffer.from([1, 2, 3, 4]);
    let notified: { seq: number; ms: number } | null = null;
    const t0 = Date.now();
    const subId = erConnection.onAccountChange(
      roomPda,
      (info) => {
        const decoded = program.coder.accounts.decode("room", info.data);
        notified = { seq: decoded.seq.toNumber(), ms: Date.now() - t0 };
      },
      "processed",
    );

    const start = Date.now();
    await programErSession.methods
      .setState(payload)
      .accounts({ room: roomPda, presence: presencePda, signer: session.publicKey })
      .rpc();
    console.log(`${Date.now() - start}ms set_state on ER (session-signed)`);

    // Wait briefly for the subscription callback.
    for (let i = 0; i < 50 && !notified; i++) await new Promise((r) => setTimeout(r, 100));
    await erConnection.removeAccountChangeListener(subId);
    assert.ok(notified, "processed-commitment WS notification should fire");
    console.log(`WS notification after ${notified!.ms}ms, seq=${notified!.seq}`);

    const info = await erConnection.getAccountInfo(roomPda);
    const room = program.coder.accounts.decode("room", info!.data);
    assert.deepEqual([...room.state], [...payload]);
    assert.equal(room.seq.toNumber(), 1);
  });

  it("writes presence on the ER with the session key", async () => {
    const start = Date.now();
    await programErSession.methods
      .setPresence(Buffer.from([42, 7]))
      .accounts({ presence: presencePda, signer: session.publicKey })
      .rpc();
    console.log(`${Date.now() - start}ms set_presence on ER`);
    const info = await erConnection.getAccountInfo(presencePda);
    const presence = program.coder.accounts.decode("presence", info!.data);
    assert.deepEqual([...presence.data], [42, 7]);
  });

  it("commits room state to the base layer", async () => {
    const txHash = await programErSession.methods
      .commitRoom()
      .accounts({ payer: session.publicKey, room: roomPda })
      .rpc();
    // GetCommitmentSignature reads the ER tx and requires >= confirmed.
    const erConfirmed = new web3.Connection(erConnection.rpcEndpoint, {
      wsEndpoint: process.env.EPHEMERAL_WS_ENDPOINT || "ws://localhost:7800",
      commitment: "confirmed",
    });
    const sig = await GetCommitmentSignature(txHash, erConfirmed);
    console.log("Base-layer commit signature:", sig);
    assert.ok(sig);
  });

  it("leaves the room (commit + undelegate presence, session-signed)", async () => {
    await programErSession.methods
      .leaveRoom()
      .accounts({ payer: session.publicKey, presence: presencePda })
      .rpc();
    // Undelegation lands on the base layer asynchronously.
    for (let i = 0; i < 30; i++) {
      const info = await base.connection.getAccountInfo(presencePda);
      if (info && info.owner.equals(program.programId)) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    const info = await base.connection.getAccountInfo(presencePda);
    assert.equal(info!.owner.toBase58(), program.programId.toBase58());
  });

  it("undelegates the room (creator wallet)", async () => {
    await programErWallet.methods
      .undelegateRoom()
      .accounts({ payer: wallet.publicKey, room: roomPda })
      .rpc();
    for (let i = 0; i < 30; i++) {
      const info = await base.connection.getAccountInfo(roomPda);
      if (info && info.owner.equals(program.programId)) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    const room = await program.account.room.fetch(roomPda);
    assert.equal(room.seq.toNumber(), 1, "ER state must survive undelegation");
    assert.deepEqual([...room.state], [1, 2, 3, 4]);
  });

  it("closes presence and room, reclaiming rent", async () => {
    await program.methods
      .closePresence()
      .accounts({ presence: presencePda, player: wallet.publicKey })
      .rpc({ skipPreflight: true });
    await program.methods
      .closeRoom()
      .accounts({ room: roomPda, creator: wallet.publicKey })
      .rpc({ skipPreflight: true });
    assert.equal(await base.connection.getAccountInfo(roomPda), null);
    assert.equal(await base.connection.getAccountInfo(presencePda), null);
  });
});
