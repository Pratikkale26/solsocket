import { BN, Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { Codec, jsonCodec } from "./codec";
import {
  decodePresence,
  decodeRoom,
  PRESENCE_ROOM_OFFSET,
  PROGRAM_ID,
  PresenceAccount,
} from "./engine";
import { isKeypair, sendInstructions, WalletLike } from "./sender";

export interface StateUpdate<T> {
  state: T;
  seq: number;
}

export interface PresenceUpdate<T> {
  /** Wallet of the player whose presence changed. */
  player: PublicKey;
  data: T;
  seq: number;
}

export interface RoomMessage<M> {
  /** Wallet of the player who emitted the message. */
  player: PublicKey;
  /** Event name passed to `emit` ("chat", "emote", …). */
  name: string;
  data: M;
  /** ER transaction signature carrying the message. */
  signature: string;
}

export interface RoomContext {
  base: Connection;
  er: Connection;
  program: Program;
  session: Keypair;
  wallet: WalletLike | Keypair;
}

export interface BroadcastOptions {
  /** Wait for `processed` confirmation on the ER (default: fire-and-forget —
   *  the websocket subscription is the source of truth). */
  confirm?: boolean;
}

/**
 * A live multiplayer room. All realtime traffic runs on the Ephemeral Rollup,
 * signed by the session key — no wallet popups, no fees, ~50ms writes.
 */
export class Room<T = unknown, P = T, M = unknown> {
  private stateListeners = new Set<(u: StateUpdate<T>) => void>();
  private presenceListeners = new Set<(u: PresenceUpdate<P>) => void>();
  private messageListeners = new Set<(m: RoomMessage<M>) => void>();
  private stateSubId: number | null = null;
  private presenceSubId: number | null = null;
  private logsSubId: number | null = null;
  private readonly presenceCodec: Codec<P>;
  private readonly messageCodec: Codec<M>;

  constructor(
    readonly address: PublicKey,
    readonly presenceAddress: PublicKey,
    private readonly ctx: RoomContext,
    private readonly codec: Codec<T>,
    messageCodec?: Codec<M>,
    presenceCodec?: Codec<P>,
  ) {
    this.messageCodec = messageCodec ?? jsonCodec<M>();
    // When P differs from T a presenceCodec must be supplied; the default
    // (sharing the state codec) is only sound for the P = T case.
    this.presenceCodec = presenceCodec ?? (codec as unknown as Codec<P>);
  }

  private get walletPubkey(): PublicKey {
    return isKeypair(this.ctx.wallet)
      ? this.ctx.wallet.publicKey
      : this.ctx.wallet.publicKey;
  }

  /** Subscribe to shared-state changes. Returns an unsubscribe function. */
  onStateChange(listener: (u: StateUpdate<T>) => void): () => void {
    this.stateListeners.add(listener);
    if (this.stateSubId === null) {
      // `processed` fires at ER slot time (~50ms); `confirmed` notifications
      // are not reliably emitted by the ER.
      this.stateSubId = this.ctx.er.onAccountChange(
        this.address,
        (info) => {
          const room = decodeRoom(this.ctx.program, info.data);
          const update = {
            state: this.codec.decode(Uint8Array.from(room.state)),
            seq: room.seq.toNumber(),
          };
          for (const cb of this.stateListeners) cb(update);
        },
        "processed",
      );
    }
    return () => this.stateListeners.delete(listener);
  }

  /** Subscribe to every player's presence updates (cursor positions, etc.). */
  onPresence(listener: (u: PresenceUpdate<P>) => void): () => void {
    this.presenceListeners.add(listener);
    if (this.presenceSubId === null) {
      this.presenceSubId = this.ctx.er.onProgramAccountChange(
        PROGRAM_ID,
        (keyed) => {
          let presence: PresenceAccount;
          try {
            presence = decodePresence(this.ctx.program, keyed.accountInfo.data);
          } catch {
            return; // a non-presence account (e.g. the room itself)
          }
          const update = {
            player: presence.player,
            data: this.presenceCodec.decode(Uint8Array.from(presence.data)),
            seq: presence.seq.toNumber(),
          };
          for (const cb of this.presenceListeners) cb(update);
        },
        {
          commitment: "processed",
          filters: [
            {
              memcmp: {
                offset: PRESENCE_ROOM_OFFSET,
                bytes: this.address.toBase58(),
              },
            },
          ],
        },
      );
    }
    return () => this.presenceListeners.delete(listener);
  }

  /**
   * Subscribe to ephemeral messages (see `emit`). Pass an event name to hear
   * only that event, or just a listener to hear everything:
   *
   *   room.onMessage("chat", ({ player, data }) => addBubble(player, data));
   *   room.onMessage(({ name, data }) => log(name, data));
   */
  onMessage(listener: (m: RoomMessage<M>) => void): () => void;
  onMessage(name: string, listener: (m: RoomMessage<M>) => void): () => void;
  onMessage(
    nameOrListener: string | ((m: RoomMessage<M>) => void),
    maybeListener?: (m: RoomMessage<M>) => void,
  ): () => void {
    const listener =
      typeof nameOrListener === "string"
        ? (m: RoomMessage<M>) => {
            if (m.name === nameOrListener) maybeListener!(m);
          }
        : nameOrListener;
    this.messageListeners.add(listener);
    if (this.logsSubId === null) {
      // Events live only in transaction logs; a mentions subscription on the
      // room address delivers them at ER slot time, same as account writes.
      this.logsSubId = this.ctx.er.onLogs(
        this.address,
        (logs) => {
          if (logs.err) return;
          for (const line of logs.logs) {
            const prefix = "Program data: ";
            if (!line.startsWith(prefix)) continue;
            let event;
            try {
              event = this.ctx.program.coder.events.decode(line.slice(prefix.length));
            } catch {
              continue;
            }
            if (!event || event.name !== "roomEvent") continue;
            const raw = event.data as {
              room: PublicKey;
              player: PublicKey;
              name: string;
              data: Buffer;
            };
            if (!raw.room.equals(this.address)) continue;
            const message = {
              player: raw.player,
              name: raw.name,
              data: this.messageCodec.decode(Uint8Array.from(raw.data)),
              signature: logs.signature,
            };
            for (const cb of this.messageListeners) cb(message);
          }
        },
        "processed",
      );
    }
    return () => this.messageListeners.delete(listener);
  }

  /**
   * Fire an ephemeral message — like `broadcast`, but nothing is written to
   * any account: the payload rides in the transaction logs (chat lines, hits,
   * reactions — events, not state). Zero-fee, session-signed, ~50ms delivery.
   */
  async emit(name: string, data: M, opts: BroadcastOptions = {}): Promise<string> {
    const ix = await this.ctx.program.methods
      .emitEvent(name, Buffer.from(this.messageCodec.encode(data)))
      .accounts({
        room: this.address,
        presence: this.presenceAddress,
        signer: this.ctx.session.publicKey,
      })
      .instruction();
    return sendInstructions({
      connection: this.ctx.er,
      instructions: [ix],
      feePayer: this.ctx.session.publicKey,
      signers: [this.ctx.session],
      commitment: "processed",
      fireAndForget: !opts.confirm,
    });
  }

  /** Publish this player's presence blob (position, status — sticky state
   *  others can read anytime; for one-shot events use `emit`). */
  async broadcast(data: P, opts: BroadcastOptions = {}): Promise<string> {
    const ix = await this.ctx.program.methods
      .setPresence(Buffer.from(this.presenceCodec.encode(data)))
      .accounts({
        presence: this.presenceAddress,
        signer: this.ctx.session.publicKey,
      })
      .instruction();
    return sendInstructions({
      connection: this.ctx.er,
      instructions: [ix],
      feePayer: this.ctx.session.publicKey,
      signers: [this.ctx.session],
      commitment: "processed",
      fireAndForget: !opts.confirm,
    });
  }

  /** Write the shared room state (any member; last write wins, seq orders). */
  async setState(data: T, opts: BroadcastOptions = {}): Promise<string> {
    const ix = await this.ctx.program.methods
      .setState(Buffer.from(this.codec.encode(data)))
      .accounts({
        room: this.address,
        presence: this.presenceAddress,
        signer: this.ctx.session.publicKey,
      })
      .instruction();
    return sendInstructions({
      connection: this.ctx.er,
      instructions: [ix],
      feePayer: this.ctx.session.publicKey,
      signers: [this.ctx.session],
      commitment: "processed",
      fireAndForget: !opts.confirm,
    });
  }

  /** Read the current shared state from the ER. */
  async getState(): Promise<StateUpdate<T> | null> {
    const info = await this.ctx.er.getAccountInfo(this.address, "processed");
    if (!info) return null;
    const room = decodeRoom(this.ctx.program, info.data);
    return {
      state: this.codec.decode(Uint8Array.from(room.state)),
      seq: room.seq.toNumber(),
    };
  }

  /** Stop listening without leaving the room on-chain. */
  async unsubscribe(): Promise<void> {
    if (this.stateSubId !== null) {
      await this.ctx.er.removeAccountChangeListener(this.stateSubId).catch(() => {});
      this.stateSubId = null;
    }
    if (this.presenceSubId !== null) {
      await this.ctx.er
        .removeProgramAccountChangeListener(this.presenceSubId)
        .catch(() => {});
      this.presenceSubId = null;
    }
    if (this.logsSubId !== null) {
      await this.ctx.er.removeOnLogsListener(this.logsSubId).catch(() => {});
      this.logsSubId = null;
    }
    this.stateListeners.clear();
    this.presenceListeners.clear();
    this.messageListeners.clear();
  }

  /**
   * Leave: commit this player's presence back to the base layer and undelegate
   * it. Session-signed — leaving is popup-free too.
   */
  async leave(): Promise<void> {
    const ix = await this.ctx.program.methods
      .leaveRoom()
      .accounts({
        payer: this.ctx.session.publicKey,
        presence: this.presenceAddress,
      })
      .instruction();
    await sendInstructions({
      connection: this.ctx.er,
      instructions: [ix],
      feePayer: this.ctx.session.publicKey,
      signers: [this.ctx.session],
      commitment: "processed",
    });
    await this.unsubscribe();
  }

  /**
   * Creator only: commit + undelegate the room itself back to the base layer.
   * Wallet-signed — an occasional, deliberate action.
   */
  async closeToBase(): Promise<void> {
    const wallet = this.ctx.wallet;
    const ix = await this.ctx.program.methods
      .undelegateRoom()
      .accounts({ payer: this.walletPubkey, room: this.address })
      .instruction();
    await sendInstructions({
      connection: this.ctx.er,
      instructions: [ix],
      feePayer: this.walletPubkey,
      signers: isKeypair(wallet) ? [wallet] : [],
      wallet: isKeypair(wallet) ? undefined : wallet,
      commitment: "processed",
    });
    await this.unsubscribe();
  }
}
