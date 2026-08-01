import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";

/** Demo burner wallet, persisted per browser. It only pays the one-time
 *  base-layer join (~0.005 SOL devnet rent); realtime traffic is free. */
export function loadBurnerWallet(): Keypair {
  const key = "solsocket-gather:wallet";
  const stored = localStorage.getItem(key);
  if (stored) {
    try {
      return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(stored)));
    } catch {
      /* rotate below */
    }
  }
  const kp = Keypair.generate();
  localStorage.setItem(key, JSON.stringify([...kp.secretKey]));
  return kp;
}

export async function requestAirdrop(
  connection: Connection,
  wallet: Keypair,
): Promise<string> {
  const sig = await connection.requestAirdrop(wallet.publicKey, 1 * LAMPORTS_PER_SOL);
  await connection.confirmTransaction(sig, "confirmed");
  return sig;
}
