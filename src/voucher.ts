// Cumulative vouchers: the agent-side and creditor-side primitives.
//
// An agent that consumes a metered service signs, after every request, a voucher with its new
// RUNNING TOTAL. Signing is local and free; nothing touches a chain. The creditor verifies each
// voucher locally and keeps only the latest, then settles on-chain now and then with
// `settleVoucher` / `settleVouchers`, and the contract charges the difference from what it has
// already settled. The struct mirrors the contract's VOUCHER_TYPEHASH exactly.
import {
  parseSignature,
  recoverTypedDataAddress,
  serializeSignature,
  zeroHash,
  type Address,
  type Hex,
  type LocalAccount,
} from "viem";
import { CHARGE_DOMAIN_NAME, CHARGE_DOMAIN_VERSION } from "./charge.ts";

/** Anything that signs EIP-712 typed data the way a viem account does (`privateKeyToAccount`, a smart-account signer). */
export type TypedDataSigner = Pick<LocalAccount, "signTypedData">;

export const VOUCHER_TYPES = {
  Voucher: [
    { name: "lienId", type: "uint256" },
    { name: "cumulativeAmount", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "ref", type: "bytes32" },
  ],
} as const;

export type VoucherDomain = { chainId: bigint | number; verifyingContract: Address };

export type UnsignedVoucher = {
  id: bigint;
  /** Total pre-fee amount the agent has consumed on this lien, ever, via vouchers. */
  cumulative: bigint;
  /** Unix seconds after which the contract refuses this voucher. */
  deadline: bigint;
  /** 32-byte hash of the off-chain receipt this voucher covers (zero when unused). */
  ref: Hex;
};

export type SignedVoucher = UnsignedVoucher & { r: Hex; s: Hex; v: number };

/** Reason codes the contract reports (`VoucherRejected.code`) for a voucher it did not apply. */
export const VOUCHER_REJECTION: Record<number, string> = {
  1: "not active",
  2: "not creditor",
  3: "frozen",
  4: "past due",
  5: "voucher expired",
  6: "stale voucher",
  7: "over limit",
  8: "bad agent signature",
};

export function voucherDomain(d: VoucherDomain) {
  return { name: CHARGE_DOMAIN_NAME, version: CHARGE_DOMAIN_VERSION, chainId: Number(d.chainId), verifyingContract: d.verifyingContract };
}

function message(v: UnsignedVoucher) {
  return { lienId: v.id, cumulativeAmount: v.cumulative, deadline: v.deadline, ref: v.ref };
}

/** The 65-byte r||s||v signature of a signed voucher. Throws for a malformed one. */
export function voucherSignature(v: Pick<SignedVoucher, "r" | "s" | "v">): Hex {
  return v.v === 0 || v.v === 1
    ? serializeSignature({ r: v.r, s: v.s, yParity: v.v })
    : serializeSignature({ r: v.r, s: v.s, v: BigInt(v.v) });
}

/** Split a 65-byte signature into the voucher's r, s, v (v as 27 or 28). */
export function splitVoucherSignature(signature: Hex): { r: Hex; s: Hex; v: number } {
  const sig = parseSignature(signature);
  const v = sig.v !== undefined ? Number(sig.v) : 27 + (sig.yParity ?? 0);
  return { r: sig.r, s: sig.s, v: v < 27 ? v + 27 : v };
}

/** Agent side: sign a voucher. `ref` defaults to zero. */
export async function signVoucher(
  signer: TypedDataSigner,
  domain: VoucherDomain,
  v: Omit<UnsignedVoucher, "ref"> & { ref?: Hex },
): Promise<SignedVoucher> {
  const unsigned: UnsignedVoucher = { ...v, ref: v.ref ?? zeroHash };
  const raw = await signer.signTypedData({ domain: voucherDomain(domain), types: VOUCHER_TYPES, primaryType: "Voucher", message: message(unsigned) });
  return { ...unsigned, ...splitVoucherSignature(raw) };
}

/** Creditor side: the address that signed this voucher, or null if the signature is malformed. */
export async function recoverVoucherSigner(domain: VoucherDomain, v: SignedVoucher): Promise<Address | null> {
  try {
    return await recoverTypedDataAddress({
      domain: voucherDomain(domain),
      types: VOUCHER_TYPES,
      primaryType: "Voucher",
      message: message(v),
      signature: voucherSignature(v),
    });
  } catch {
    return null;
  }
}
