import { BN, Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { Codec } from "./codec";
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
export class Room<T = unknown> {
  private stateListeners = new Set<(u: StateUpdate<T>) => void>();
  private presenceListeners = new Set<(u: PresenceUpdate<T>) => void>();
  private stateSubId: number | null = null;
  private presenceSubId: number | null = null;

  constructor(
    readonly address: PublicKey,
    readonly presenceAddress: PublicKey,
    private readonly ctx: RoomContext,
    private readonly codec: Codec<T>,
  ) {}

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
  onPresence(listener: (u: PresenceUpdate<T>) => void): () => void {
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
            data: this.codec.decode(Uint8Array.from(presence.data)),
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

  /** Publish this player's presence blob — the socket.io `emit` of solsocket. */
  async broadcast(data: T, opts: BroadcastOptions = {}): Promise<string> {
    const ix = await this.ctx.program.methods
      .setPresence(Buffer.from(this.codec.encode(data)))
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
    this.stateListeners.clear();
    this.presenceListeners.clear();
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
