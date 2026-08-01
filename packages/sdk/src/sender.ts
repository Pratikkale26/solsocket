import { utils } from "@coral-xyz/anchor";
import {
  Commitment,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

/** Wallet-adapter compatible signer; a bare Keypair also satisfies the flows. */
export interface WalletLike {
  publicKey: PublicKey;
  signTransaction<T extends Transaction>(tx: T): Promise<T>;
}

export function isKeypair(w: WalletLike | Keypair): w is Keypair {
  return "secretKey" in w;
}

export interface SendOptions {
  connection: Connection;
  instructions: TransactionInstruction[];
  feePayer: PublicKey;
  /** Keypairs that sign locally (session keys). */
  signers?: Keypair[];
  /** Adapter wallet that signs interactively (base-layer flows). */
  wallet?: WalletLike;
  commitment?: Commitment;
  /** Skip confirmation entirely — subscriptions carry the truth. */
  fireAndForget?: boolean;
}

/**
 * Blockhash cache, keyed per RPC endpoint. High-frequency broadcast() calls
 * would otherwise pay a full RPC round trip per message. TTL stays well under
 * blockhash validity even at the ER's 50ms slot time (150 slots ≈ 7.5s).
 */
const BLOCKHASH_TTL_MS = 2_000;
const blockhashCache = new Map<
  string,
  { blockhash: string; lastValidBlockHeight: number; fetchedAt: number }
>();

async function recentBlockhash(connection: Connection, commitment: Commitment) {
  const key = connection.rpcEndpoint;
  const cached = blockhashCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < BLOCKHASH_TTL_MS) return cached;
  const fresh = await connection.getLatestBlockhash(commitment);
  const entry = { ...fresh, fetchedAt: Date.now() };
  blockhashCache.set(key, entry);
  return entry;
}

/**
 * Commit/undelegate flows can transiently fail while the ER catches up on a
 * fresh (re)delegation — the clone briefly shows the wrong owner. Retry
 * on-chain failures with spacing; rethrow anything else immediately.
 */
export async function sendInstructionsWithRetry(
  opts: SendOptions & { attempts?: number; delayMs?: number },
): Promise<string> {
  const { attempts = 6, delayMs = 5_000, ...send } = opts;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await sendInstructions(send);
    } catch (err) {
      if (!(err instanceof Error) || !err.message.includes("failed on-chain")) throw err;
      lastErr = err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

export async function sendInstructions(opts: SendOptions): Promise<string> {
  const {
    connection,
    instructions,
    feePayer,
    signers = [],
    wallet,
    commitment = "confirmed",
    fireAndForget = false,
  } = opts;

  const { blockhash, lastValidBlockHeight } = await recentBlockhash(
    connection,
    commitment,
  );
  let tx = new Transaction({ blockhash, lastValidBlockHeight, feePayer });
  tx.add(...instructions);

  if (wallet && !isKeypair(wallet)) tx = await wallet.signTransaction(tx);
  if (signers.length > 0) tx.partialSign(...signers);

  let signature: string;
  try {
    signature = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: true,
    });
  } catch (err) {
    // A byte-identical resend (same payload, same cached blockhash — e.g. an
    // idle presence heartbeat) is rejected as a duplicate. The first copy
    // landed, so this IS success — surface it as such.
    if (
      err instanceof Error &&
      err.message.includes("already been processed") &&
      tx.signature
    ) {
      return utils.bytes.bs58.encode(tx.signature);
    }
    throw err;
  }
  if (!fireAndForget) {
    const conf = await connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      commitment,
    );
    if (conf.value.err) {
      throw new Error(
        `transaction ${signature} failed on-chain: ${JSON.stringify(conf.value.err)}`,
      );
    }
  }
  return signature;
}
