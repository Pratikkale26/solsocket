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

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash(commitment);
  let tx = new Transaction({ blockhash, lastValidBlockHeight, feePayer });
  tx.add(...instructions);

  if (wallet && !isKeypair(wallet)) tx = await wallet.signTransaction(tx);
  if (signers.length > 0) tx.partialSign(...signers);

  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: true,
  });
  if (!fireAndForget) {
    await connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      commitment,
    );
  }
  return signature;
}
