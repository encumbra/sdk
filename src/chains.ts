// Network configuration for the Encumbra SDK.
//
// Encumbra launches on Base Sepolia (84532). The SDK is EVM-generic, but it ships
// Base Sepolia as the default and only *supported* write target: exec() writes are
// testnet-only until mainnet launch. A `Network` pairs a viem chain with the
// deployed contract address and settlement token.
import { type Chain } from "viem";
import { baseSepolia } from "viem/chains";
import type { Address } from "viem";

export const DEFAULT_CHAIN_ID = 84532 as const;

/** Circle's testnet USDC on Base Sepolia: the default settlement token. */
export const BASE_SEPOLIA_USDC: Address = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

export type EncumbraNetwork = {
  chainId: number;
  /** viem chain object used to build clients. */
  chain: Chain;
  /** Deployed EncumbraLien registry. Empty until the contract is live on this chain. */
  address: Address | "";
  /** Settlement/debt token (USDC by default). */
  settlementToken: Address | "";
  /** Human label. */
  name: string;
  /** JSON-RPC endpoint used when the caller does not supply one. */
  defaultRpcUrl: string;
};

/** The chains the SDK knows about. Base Sepolia is the only supported one for now. */
export const NETWORKS: Record<number, EncumbraNetwork> = {
  84532: {
    chainId: 84532,
    chain: baseSepolia,
    address: "", // published once EncumbraLien is deployed to Base Sepolia
    settlementToken: BASE_SEPOLIA_USDC,
    name: "Base Sepolia",
    defaultRpcUrl: "https://sepolia.base.org",
  },
};

export function networkFor(chainId: number): EncumbraNetwork {
  const net = NETWORKS[chainId];
  if (!net) throw new Error(`Unsupported chainId ${chainId}. Known: ${Object.keys(NETWORKS).join(", ")}`);
  return net;
}

/** Chains on which exec() permits signing and broadcasting (testnet only until mainnet launch). */
export const WRITE_ALLOWED_CHAIN_IDS: readonly number[] = [84532];

export function isWriteAllowed(chainId: number): boolean {
  return WRITE_ALLOWED_CHAIN_IDS.includes(chainId);
}
