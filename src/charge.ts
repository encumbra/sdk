// The agent's per-draw authorization (EIP-712).
//
// An agent does not send transactions to draw credit. It signs a bounded `Charge`
// message off-chain; the creditor submits it via `chargeWithAuth`. This is the safest
// agent surface in Encumbra: signing costs no gas, moves no funds directly, and the
// worst case from a leaked agent key is bounded by the lien's credit limit (the
// owner's collateral still backs it). The struct mirrors the contract exactly.
import type { Address } from "viem";
import type { ChargeTypedData } from "./types.ts";

export const CHARGE_DOMAIN_NAME = "Encumbra" as const;
export const CHARGE_DOMAIN_VERSION = "1" as const;

export const CHARGE_TYPES = {
  Charge: [
    { name: "lienId", type: "uint256" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export type BuildChargeTypedDataParams = {
  chainId: number | bigint;
  verifyingContract: Address;
  lienId: bigint;
  amount: bigint;
  nonce: bigint;
  deadline: bigint;
};

/**
 * Build the EIP-712 typed data for a single draw. Pass the result to a wallet's
 * `signTypedData`. The `nonce` must be the lien's current `chargeNonce` and the
 * `chainId`/`verifyingContract` must match the deployed contract, or the signature
 * will be rejected on-chain.
 */
export function buildChargeTypedData(p: BuildChargeTypedDataParams): ChargeTypedData {
  return {
    domain: {
      name: CHARGE_DOMAIN_NAME,
      version: CHARGE_DOMAIN_VERSION,
      chainId: Number(p.chainId),
      verifyingContract: p.verifyingContract,
    },
    types: CHARGE_TYPES,
    primaryType: "Charge",
    message: {
      lienId: p.lienId,
      amount: p.amount,
      nonce: p.nonce,
      deadline: p.deadline,
    },
  };
}

/** Default signing window for a charge authorization: one hour. */
export const DEFAULT_CHARGE_TTL_SECONDS = 3600n;
