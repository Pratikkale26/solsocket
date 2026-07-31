import { BN, Program } from "@coral-xyz/anchor";
import { sha256 } from "@noble/hashes/sha256";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { Codec, jsonCodec } from "./codec";
import { ClusterConfig, ClusterName, Region, resolveCluster } from "./connections";
import {
  accountFilter,
  decodePresence,
  decodeRoom,
  makeProgram,
  presencePda,
  PRESENCE_ROOM_OFFSET,
  PROGRAM_ID,
  roomPda,
} from "./engine";
import { Room } from "./room";
import { isKeypair, sendInstructions, WalletLike } from "./sender";
import { loadOrCreateSession } from "./session";

export interface ConnectOptions {
  /** Wallet adapter (browser) or Keypair (node). Signs base-layer txs only. */
  wallet: WalletLike | Keypair;
  /** "devnet" (default), "local", or explicit endpoints. */
  cluster?: ClusterName | ClusterConfig;
  /** Devnet ER region — pick the one closest to your players ("asia" is the
   *  default). A room lives on the region it was created on, so everyone
   *  joining it must connect with the same region. */
  region?: Region;
  /** Override the auto-managed session key. */
  session?: Keypair;
}

export interface CreateRoomOptions<T, P = T, M = unknown> {
  /** Unique per creator; random by default. */
  id?: number | BN;
  maxPlayers?: number;
  initialState?: T;
  codec?: Codec<T>;
  /** Codec for `broadcast`/`onPresence` payloads (default: the state codec —
   *  pass one whenever presence has a different shape than room state). */
  presenceCodec?: Codec<P>;
  /** Codec for `emit`/`onMessage` payloads (default: JSON). */
  messageCodec?: Codec<M>;
}

export interface JoinRoomOptions<T, P = T, M = unknown> {
  codec?: Codec<T>;
  /** Codec for `broadcast`/`onPresence` payloads (default: the state codec). */
  presenceCodec?: Codec<P>;
  /** Codec for `emit`/`onMessage` payloads (default: JSON). */
  messageCodec?: Codec<M>;
}

export interface JoinOrCreateOptions<T, P = T, M = unknown>
  extends CreateRoomOptions<T, P, M> {
  /** Whose named room to join. Defaults to this wallet — pass the room
   *  owner's pubkey to join someone else's named room. */
  creator?: PublicKey;
}

/** A live room found by `listRooms`. */
export interface RoomListing {
  /** Pass to `joinRoom` to enter. */
  address: PublicKey;
  creator: PublicKey;
  id: BN;
  maxPlayers: number;
  /** Players currently holding a presence slot (includes idle ones). */
  players: number;
  /** Total writes to the room state — a proxy for how active it has been. */
  seq: number;
}

/** Deterministic room id for a name: first 8 bytes of sha256(name). */
export function nameToRoomId(name: string): BN {
  const digest = sha256(new TextEncoder().encode(name));
  return new BN(Buffer.from(digest.subarray(0, 8)), "le");
}

const ER_READY_TIMEOUT_MS = 15_000;

/**
 * Entry point. One `connect`, then rooms:
 *
 *   const sock = SolSocket.connect({ wallet, cluster: "devnet" });
 *   const room = await sock.createRoom<{ x: number; y: number }>();
 *   room.onPresence(({ player, data }) => draw(player, data));
 *   room.broadcast({ x, y });
 */
export class SolSocket {
  readonly base: Connection;
  readonly er: Connection;
  readonly cluster: ClusterConfig;
  readonly session: Keypair;
  readonly wallet: WalletLike | Keypair;
  private readonly program: Program;

  private constructor(opts: ConnectOptions) {
    this.cluster = resolveCluster(opts.cluster ?? "devnet", opts.region);
    this.base = new Connection(this.cluster.baseRpc, {
      wsEndpoint: this.cluster.baseWs,
      commitment: "confirmed",
    });
    this.er = new Connection(this.cluster.erRpc, {
      wsEndpoint: this.cluster.erWs,
      commitment: "processed",
    });
    this.wallet = opts.wallet;
    this.session = opts.session ?? loadOrCreateSession();
    this.program = makeProgram(this.base);
  }

  static connect(opts: ConnectOptions): SolSocket {
    return new SolSocket(opts);
  }

  get walletPubkey(): PublicKey {
    return this.wallet.publicKey;
  }

  /** Deterministic room address from its creator and id. */
  roomAddress(creator: PublicKey, id: number | BN): PublicKey {
    return roomPda(creator, new BN(id));
  }

  /** Deterministic room address for a named room (see `joinOrCreate`). */
  roomAddressForName(creator: PublicKey, name: string): PublicKey {
    return roomPda(creator, nameToRoomId(name));
  }

  /**
   * Discover rooms that are live on this cluster's ephemeral rollup, most
   * populated first — the lobby browser. Anyone can join any listed room:
   *
   *   const [busiest] = await sock.listRooms();
   *   const room = await sock.joinRoom(busiest.address);
   */
  async listRooms(): Promise<RoomListing[]> {
    const [rooms, presences] = await Promise.all([
      this.er.getProgramAccounts(PROGRAM_ID, {
        commitment: "processed",
        filters: [accountFilter("Room")],
      }),
      this.er.getProgramAccounts(PROGRAM_ID, {
        commitment: "processed",
        // Only the 32-byte `room` field — enough to count players per room.
        dataSlice: { offset: PRESENCE_ROOM_OFFSET, length: 32 },
        filters: [accountFilter("Presence")],
      }),
    ]);
    const players = new Map<string, number>();
    for (const { account } of presences) {
      const room = new PublicKey(account.data).toBase58();
      players.set(room, (players.get(room) ?? 0) + 1);
    }
    return rooms
      .map(({ pubkey, account }) => {
        const room = decodeRoom(this.program, account.data);
        return {
          address: pubkey,
          creator: room.creator,
          id: room.roomId,
          maxPlayers: room.maxPlayers,
          players: players.get(pubkey.toBase58()) ?? 0,
          seq: room.seq.toNumber(),
        };
      })
      .sort((a, b) => b.players - a.players || b.seq - a.seq);
  }

  /**
   * Join a named room, creating it first if it doesn't exist — the Colyseus
   * `joinOrCreate`. The name deterministically addresses the room, so every
   * client calling `joinOrCreate("lobby")` with the same creator lands in the
   * same room and nobody has to branch on create-vs-join:
   *
   *   const room = await sock.joinOrCreate("lobby", { creator: OWNER });
   */
  async joinOrCreate<T = unknown, P = T, M = unknown>(
    name: string,
    opts: JoinOrCreateOptions<T, P, M> = {},
  ): Promise<Room<T, P, M>> {
    const creator = opts.creator ?? this.walletPubkey;
    const id = nameToRoomId(name);
    const address = roomPda(creator, id);

    const info = await this.base.getAccountInfo(address);
    if (info) return this.joinRoom<T, P, M>(address, opts);
    if (!creator.equals(this.walletPubkey)) {
      throw new Error(
        `room "${name}" does not exist yet for creator ${creator.toBase58()} — ` +
          `its owner must create it first (joinOrCreate with their own wallet)`,
      );
    }
    try {
      return await this.createRoom<T, P, M>({ ...opts, id });
    } catch (err) {
      // Lost a create race: someone else's transaction landed first. Join it.
      const nowExists = await this.base.getAccountInfo(address);
      if (nowExists) return this.joinRoom<T, P, M>(address, opts);
      throw err;
    }
  }

  /**
   * Create a room, join it, and delegate both accounts to the ER — one
   * base-layer transaction, one wallet signature. Resolves when the room is
   * live on the ER.
   */
  async createRoom<T = unknown, P = T, M = unknown>(
    opts: CreateRoomOptions<T, P, M> = {},
  ): Promise<Room<T, P, M>> {
    const codec = opts.codec ?? jsonCodec<T>();
    const id = new BN(opts.id ?? Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));
    const creator = this.walletPubkey;
    const room = roomPda(creator, id);
    const presence = presencePda(room, creator);
    const validatorAccounts = [
      { pubkey: this.cluster.validator, isSigner: false, isWritable: false },
    ];

    const initial = Buffer.from(
      opts.initialState === undefined ? [] : codec.encode(opts.initialState),
    );
    const instructions = [
      await this.program.methods
        .createRoom(id, opts.maxPlayers ?? 32, initial)
        .accounts({ creator })
        .instruction(),
      await this.program.methods
        .joinRoom(this.session.publicKey)
        .accounts({ room, player: creator })
        .instruction(),
      await this.program.methods
        .delegateRoom(creator, id)
        .accounts({ payer: creator, pda: room })
        .remainingAccounts(validatorAccounts)
        .instruction(),
      await this.program.methods
        .delegatePresence(room, creator)
        .accounts({ payer: creator, pda: presence })
        .remainingAccounts(validatorAccounts)
        .instruction(),
    ];
    await this.sendBase(instructions);
    await this.waitForEr(room);
    return new Room<T, P, M>(room, presence, this.roomContext(), codec, opts.messageCodec, opts.presenceCodec);
  }

  /**
   * Join an existing room: create + delegate this player's presence slot.
   * Handles rejoin (rotating a lost session key) transparently.
   */
  async joinRoom<T = unknown, P = T, M = unknown>(
    roomAddress: PublicKey | string,
    opts: JoinRoomOptions<T, P, M> = {},
  ): Promise<Room<T, P, M>> {
    const codec = opts.codec ?? jsonCodec<T>();
    const room = new PublicKey(roomAddress);
    const player = this.walletPubkey;
    const presence = presencePda(room, player);
    const validatorAccounts = [
      { pubkey: this.cluster.validator, isSigner: false, isWritable: false },
    ];

    const info = await this.base.getAccountInfo(presence);
    if (info && !info.owner.equals(PROGRAM_ID)) {
      // Presence is currently delegated (a previous session). If we still hold
      // that session key we can just resume; otherwise recover by leaving with
      // the wallet (allowed on-chain) and rejoining fresh.
      const current = decodePresence(this.program, info.data);
      if (current.authority.equals(this.session.publicKey)) {
        return new Room<T, P, M>(room, presence, this.roomContext(), codec, opts.messageCodec, opts.presenceCodec);
      }
      await this.recoverPresence(presence);
    }

    const instructions = [];
    const fresh = await this.base.getAccountInfo(presence);
    const needsAuthorityRotation =
      fresh !== null &&
      !decodePresence(this.program, fresh.data).authority.equals(
        this.session.publicKey,
      );
    if (fresh === null || needsAuthorityRotation) {
      instructions.push(
        await this.program.methods
          .joinRoom(this.session.publicKey)
          .accounts({ room, player })
          .instruction(),
      );
    }
    instructions.push(
      await this.program.methods
        .delegatePresence(room, player)
        .accounts({ payer: player, pda: presence })
        .remainingAccounts(validatorAccounts)
        .instruction(),
    );
    await this.sendBase(instructions);
    await this.waitForErPresence(presence);
    return new Room<T, P, M>(room, presence, this.roomContext(), codec, opts.messageCodec, opts.presenceCodec);
  }

  private roomContext() {
    return {
      base: this.base,
      er: this.er,
      program: this.program,
      session: this.session,
      wallet: this.wallet,
    };
  }

  private async sendBase(instructions: import("@solana/web3.js").TransactionInstruction[]) {
    await sendInstructions({
      connection: this.base,
      instructions,
      feePayer: this.walletPubkey,
      signers: isKeypair(this.wallet) ? [this.wallet] : [],
      wallet: isKeypair(this.wallet) ? undefined : this.wallet,
      commitment: "confirmed",
    });
  }

  /** Undelegate a presence slot whose session key we no longer hold. */
  private async recoverPresence(presence: PublicKey): Promise<void> {
    const ix = await this.program.methods
      .leaveRoom()
      .accounts({ payer: this.walletPubkey, presence })
      .instruction();
    await sendInstructions({
      connection: this.er,
      instructions: [ix],
      feePayer: this.walletPubkey,
      signers: isKeypair(this.wallet) ? [this.wallet] : [],
      wallet: isKeypair(this.wallet) ? undefined : this.wallet,
      commitment: "processed",
    });
    // Undelegation settles on the base layer asynchronously.
    const deadline = Date.now() + ER_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const info = await this.base.getAccountInfo(presence);
      if (info && info.owner.equals(PROGRAM_ID)) return;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("timed out waiting for presence undelegation during rejoin");
  }

  /**
   * Like `waitForEr`, but for a presence slot: existence is not enough — after
   * a rejoin with a rotated session key the ER can briefly serve a stale clone
   * holding the old authority, and session-signed writes would be dropped.
   * Wait until the clone carries THIS session's authority.
   */
  private async waitForErPresence(presence: PublicKey): Promise<void> {
    // Re-delegation after an authority rotation can take the ER tens of
    // seconds to pick up (observed ~30s on the local stack) — be patient,
    // this only runs during join, never on the hot path.
    const deadline = Date.now() + 3 * ER_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await this.er.requestAirdrop(presence, 1).catch(() => {});
      const info = await this.er.getAccountInfo(presence, "processed");
      if (info) {
        try {
          const current = decodePresence(this.program, info.data);
          if (current.authority.equals(this.session.publicKey)) return;
        } catch {
          // clone not decodable yet — keep polling
        }
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(
      `timed out waiting for the ephemeral rollup to pick up the new session ` +
        `authority on ${presence.toBase58()} — try again in a few seconds`,
    );
  }

  /**
   * Delegated accounts are cloned into the ER lazily; nudge with the official
   * requestAirdrop trick and poll until the account materializes.
   */
  private async waitForEr(account: PublicKey): Promise<void> {
    const deadline = Date.now() + ER_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await this.er.requestAirdrop(account, 1).catch(() => {});
      const info = await this.er.getAccountInfo(account, "processed");
      if (info) return;
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(
      `timed out waiting for ${account.toBase58()} to appear on the ephemeral rollup`,
    );
  }
}
