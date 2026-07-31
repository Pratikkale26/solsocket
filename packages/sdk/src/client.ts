import { BN, Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { Codec, jsonCodec } from "./codec";
import { ClusterConfig, ClusterName, resolveCluster } from "./connections";
import {
  decodePresence,
  makeProgram,
  presencePda,
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
  /** Override the auto-managed session key. */
  session?: Keypair;
}

export interface CreateRoomOptions<T, M = unknown> {
  /** Unique per creator; random by default. */
  id?: number;
  maxPlayers?: number;
  initialState?: T;
  codec?: Codec<T>;
  /** Codec for `emit`/`onMessage` payloads (default: JSON). */
  messageCodec?: Codec<M>;
}

export interface JoinRoomOptions<T, M = unknown> {
  codec?: Codec<T>;
  /** Codec for `emit`/`onMessage` payloads (default: JSON). */
  messageCodec?: Codec<M>;
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
    this.cluster = resolveCluster(opts.cluster ?? "devnet");
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
  roomAddress(creator: PublicKey, id: number): PublicKey {
    return roomPda(creator, new BN(id));
  }

  /**
   * Create a room, join it, and delegate both accounts to the ER — one
   * base-layer transaction, one wallet signature. Resolves when the room is
   * live on the ER.
   */
  async createRoom<T = unknown, M = unknown>(
    opts: CreateRoomOptions<T, M> = {},
  ): Promise<Room<T, M>> {
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
    return new Room<T, M>(room, presence, this.roomContext(), codec, opts.messageCodec);
  }

  /**
   * Join an existing room: create + delegate this player's presence slot.
   * Handles rejoin (rotating a lost session key) transparently.
   */
  async joinRoom<T = unknown, M = unknown>(
    roomAddress: PublicKey | string,
    opts: JoinRoomOptions<T, M> = {},
  ): Promise<Room<T, M>> {
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
        return new Room<T, M>(room, presence, this.roomContext(), codec, opts.messageCodec);
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
    await this.waitForEr(presence);
    return new Room<T, M>(room, presence, this.roomContext(), codec, opts.messageCodec);
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
