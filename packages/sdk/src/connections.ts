import { PublicKey } from "@solana/web3.js";

/**
 * A solsocket cluster is a base layer plus the Ephemeral Rollup that rooms are
 * delegated to. The validator identity pins delegation to that specific ER.
 *
 * Subscriptions must go directly to the ER's own websocket — never through the
 * Magic Router, whose WS binds to an arbitrary ER at connect time.
 */
export interface ClusterConfig {
  baseRpc: string;
  baseWs?: string;
  erRpc: string;
  erWs?: string;
  /** Validator identity passed as remaining account when delegating. */
  validator: PublicKey;
}

export const LOCAL: ClusterConfig = {
  baseRpc: "http://localhost:8899",
  baseWs: "ws://localhost:8900",
  erRpc: "http://localhost:7799",
  erWs: "ws://localhost:7800",
  validator: new PublicKey("mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev"),
};

/** MagicBlock's Asia devnet ER — the region every official example targets. */
export const DEVNET: ClusterConfig = {
  baseRpc: "https://api.devnet.solana.com",
  baseWs: "wss://api.devnet.solana.com",
  erRpc: "https://devnet-as.magicblock.app",
  erWs: "wss://devnet-as.magicblock.app",
  validator: new PublicKey("MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57"),
};

export type ClusterName = "local" | "devnet";

export function resolveCluster(cluster: ClusterName | ClusterConfig): ClusterConfig {
  if (cluster === "local") return LOCAL;
  if (cluster === "devnet") return DEVNET;
  return cluster;
}
