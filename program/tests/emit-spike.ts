import * as anchor from "@coral-xyz/anchor";
import { Program, web3 } from "@coral-xyz/anchor";
import assert from "node:assert/strict";
import type { SolsocketEngine } from "../target/types/solsocket_engine";

const ROOM_SEED = "room";
const PRESENCE_SEED = "presence";

/**
 * Feasibility spike for the ephemeral events API: emit_event writes nothing —
 * the payload lives only in transaction logs, delivered via a logsSubscribe
 * on the room address and decoded with Anchor's event coder.
 */
describe("emit_event via logsSubscribe on the ER", () => {
  const base = new anchor.AnchorProvider(
    new web3.Connection(process.env.PROVIDER_ENDPOINT || "http://localhost:8899", {
      wsEndpoint: process.env.WS_ENDPOINT || "ws://localhost:8900",
      commitment: "confirmed",
    }),
    anchor.Wallet.local(),
  );
  anchor.setProvider(base);

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

  const program = anchor.workspace.SolsocketEngine as Program<SolsocketEngine>;
  const programErSession = new Program<SolsocketEngine>(program.idl, erSession);

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

    await program.methods
      .createRoom(roomId, 8, Buffer.from([]))
      .accounts({ creator: wallet.publicKey })
      .rpc({ skipPreflight: true });
    await program.methods
      .joinRoom(session.publicKey)
      .accounts({ room: roomPda, player: wallet.publicKey })
      .rpc({ skipPreflight: true });

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
    await new Promise((r) => setTimeout(r, 3000));
  });

  it("delivers an emitted event through a room-mentions log subscription", async () => {
    const eventCoder = new anchor.BorshEventCoder(program.idl);
    const received: { name: string; player: string; text: string; ms: number }[] = [];
    let t0 = 0;

    // web3.js turns a PublicKey filter into {mentions: [pk]} on the wire.
    const subId = erConnection.onLogs(
      roomPda,
      (logs) => {
        for (const line of logs.logs) {
          const prefix = "Program data: ";
          if (!line.startsWith(prefix)) continue;
          const event = eventCoder.decode(line.slice(prefix.length));
          if (!event) continue;
          received.push({
            name: event.name,
            player: event.data.player.toBase58(),
            text: Buffer.from(event.data.data).toString("utf8"),
            ms: Date.now() - t0,
          });
        }
      },
      "processed",
    );
    // Let the subscription settle before timing the broadcast.
    await new Promise((r) => setTimeout(r, 500));

    t0 = Date.now();
    await programErSession.methods
      .emitEvent("chat", Buffer.from("hello from the ER", "utf8"))
      .accounts({ room: roomPda, presence: presencePda, signer: session.publicKey })
      .rpc();
    console.log(`${Date.now() - t0}ms emit_event rpc roundtrip`);

    for (let i = 0; i < 50 && received.length === 0; i++)
      await new Promise((r) => setTimeout(r, 100));

    assert.ok(received.length > 0, "log subscription should deliver the event");
    const ev = received[0];
    console.log(`event '${ev.name}' from ${ev.player} after ${ev.ms}ms: "${ev.text}"`);
    assert.match(ev.name, /roomEvent/i);
    assert.equal(ev.player, wallet.publicKey.toBase58());
    assert.equal(ev.text, "hello from the ER");

    // Warm-connection runs: the first emit pays TLS/blockhash cold-start.
    for (let n = 0; n < 3; n++) {
      const count = received.length;
      t0 = Date.now();
      await programErSession.methods
        .emitEvent("chat", Buffer.from(`warm ${n}`, "utf8"))
        .accounts({ room: roomPda, presence: presencePda, signer: session.publicKey })
        .rpc();
      for (let i = 0; i < 50 && received.length === count; i++)
        await new Promise((r) => setTimeout(r, 20));
      console.log(`warm emit #${n}: delivered in ${received[received.length - 1]?.ms}ms`);
    }
    await erConnection.removeOnLogsListener(subId);
  });

  it("rejects an emit from a non-member session key", async () => {
    const stranger = web3.Keypair.generate();
    // Build and send the raw transaction so the program error surfaces in
    // preflight instead of being swallowed by client-side plumbing.
    const ix = await program.methods
      .emitEvent("chat", Buffer.from("intruder"))
      .accounts({ room: roomPda, presence: presencePda, signer: stranger.publicKey })
      .instruction();
    const tx = new web3.Transaction().add(ix);
    tx.feePayer = stranger.publicKey;
    tx.recentBlockhash = (await erConnection.getLatestBlockhash()).blockhash;
    tx.sign(stranger);
    await assert.rejects(
      erConnection.sendRawTransaction(tx.serialize(), { skipPreflight: false }),
      /BadAuthority|custom program error|0x1772|Simulation failed/i,
    );
  });
});
