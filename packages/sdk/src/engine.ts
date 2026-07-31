import { AnchorProvider, BN, Program } from "@coral-xyz/anchor";
import type { Wallet } from "@coral-xyz/anchor/dist/cjs/provider";
import { Connection, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import idl from "./idl/solsocket_engine.json";

export const PROGRAM_ID = new PublicKey((idl as { address: string }).address);
export const DELEGATION_PROGRAM = new PublicKey(
  "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh",
);

const ROOM_SEED = Buffer.from("room");
const PRESENCE_SEED = Buffer.from("presence");

export function roomPda(creator: PublicKey, roomId: BN): PublicKey {
  return PublicKey.findProgramAddressSync(
    [ROOM_SEED, creator.toBuffer(), roomId.toArrayLike(Buffer, "le", 8)],
    PROGRAM_ID,
  )[0];
}

export function presencePda(room: PublicKey, player: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [PRESENCE_SEED, room.toBuffer(), player.toBuffer()],
    PROGRAM_ID,
  )[0];
}

/** Byte offset of the `room` field inside a Presence account (after the
 *  8-byte Anchor discriminator) — used for programSubscribe memcmp filters. */
export const PRESENCE_ROOM_OFFSET = 8;

export interface RoomAccount {
  creator: PublicKey;
  roomId: BN;
  maxPlayers: number;
  seq: BN;
  bump: number;
  state: Buffer;
}

export interface PresenceAccount {
  room: PublicKey;
  player: PublicKey;
  authority: PublicKey;
  seq: BN;
  bump: number;
  data: Buffer;
}

/** The Program instance is used purely as an instruction builder and account
 *  coder; transactions are assembled and signed by the SDK itself, so the
 *  provider wallet is a non-signing stub. */
const stubWallet: Wallet = {
  publicKey: PublicKey.default,
  signTransaction: <T extends Transaction | VersionedTransaction>(tx: T) =>
    Promise.resolve(tx),
  signAllTransactions: <T extends Transaction | VersionedTransaction>(txs: T[]) =>
    Promise.resolve(txs),
  payer: undefined as never,
};

export function makeProgram(connection: Connection): Program {
  const provider = new AnchorProvider(connection, stubWallet, {
    commitment: connection.commitment ?? "confirmed",
  });
  return new Program(idl as never, provider);
}

export function decodeRoom(program: Program, data: Buffer): RoomAccount {
  return program.coder.accounts.decode("room", data);
}

export function decodePresence(program: Program, data: Buffer): PresenceAccount {
  return program.coder.accounts.decode("presence", data);
}
