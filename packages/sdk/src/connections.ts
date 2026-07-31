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

/**
 * MagicBlock runs one ER per region; a room lives on the region it was
 * delegated to (the validator identity pins it), so everyone in a room shares
 * one region — pick the one closest to your players.
 */
export type Region = "asia" | "eu" | "us";

const DEVNET_REGIONS: Record<Region, { host: string; validator: string }> = {
  asia: { host: "devnet-as.magicblock.app", validator: "MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57" },
  eu: { host: "devnet-eu.magicblock.app", validator: "MEUGGrYPxKk17hCr7wpT6s8dtNokZj5U2L57vjYMS8e" },
  us: { host: "devnet-us.magicblock.app", validator: "MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd" },
};

function devnetCluster(region: Region): ClusterConfig {
  const { host, validator } = DEVNET_REGIONS[region];
  return {
    baseRpc: "https://api.devnet.solana.com",
    baseWs: "wss://api.devnet.solana.com",
    erRpc: `https://${host}`,
    erWs: `wss://${host}`,
    validator: new PublicKey(validator),
  };
}

/** MagicBlock's Asia devnet ER — the region every official example targets. */
export const DEVNET: ClusterConfig = devnetCluster("asia");

export type ClusterName = "local" | "devnet";

export function resolveCluster(
  cluster: ClusterName | ClusterConfig,
  region?: Region,
): ClusterConfig {
  if (cluster === "local") return LOCAL;
  if (cluster === "devnet") return region ? devnetCluster(region) : DEVNET;
  if (region) {
    throw new Error(
      `\`region\` only applies to the "devnet" cluster — a custom ClusterConfig ` +
        `already names its ER endpoints, so drop one of the two options`,
    );
  }
  return cluster;
}
