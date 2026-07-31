import { Keypair } from "@solana/web3.js";

/**
 * The session key signs every realtime write on the ER. ER transactions are
 * zero-fee, so a throwaway keypair with no lamports is enough — the wallet
 * only ever signs the base-layer join/delegate flow. One popup, then silence.
 *
 * Persisted in localStorage in browsers so reloads keep the same authority
 * (rejoin without a base-layer transaction); in-memory otherwise.
 */
const memoryStore = new Map<string, string>();

function storageGet(key: string): string | null {
  try {
    if (typeof localStorage !== "undefined") return localStorage.getItem(key);
  } catch {
    /* SSR / privacy mode */
  }
  return memoryStore.get(key) ?? null;
}

function storageSet(key: string, value: string): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(key, value);
      return;
    }
  } catch {
    /* SSR / privacy mode */
  }
  memoryStore.set(key, value);
}

export function loadOrCreateSession(storageKey = "solsocket:session"): Keypair {
  const stored = storageGet(storageKey);
  if (stored) {
    try {
      return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(stored)));
    } catch {
      /* corrupted entry — fall through and rotate */
    }
  }
  const fresh = Keypair.generate();
  storageSet(storageKey, JSON.stringify([...fresh.secretKey]));
  return fresh;
}
