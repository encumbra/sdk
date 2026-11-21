// The agent's consent to be named on a lien (EIP-712).
//
// Every outcome on a lien is written to its agent's on-chain record, which is what an
// underwriter sizes credit from. So the contract only lets an address be named agent with
// its agreement: the agent opens the lien itself (`open`), or it signs the exact terms here
// and the owner submits them with `openWithConsent` / `openAssetWithConsent`. A contract
// agent (smart account) signs through ERC-1271. The structs mirror the contract exactly.
//
// Both consents carry `termsHash`, the EIP-712 hash of the governance terms in force when the
// agent signed (fees, past-due grace, oracle, keeper module; see computeTermsHash). If
// governance changes the terms before the owner opens, the open reverts "terms mismatch"
// instead of opening on terms the agent never saw. An installment schedule on a lien the
// agent does not own needs its signed `LeaseSchedule` the same way.
//
// Nonces are unordered (Permit2 layout): nonce n is bit (n & 255) of word (n >> 8) in the
// agent's `consentNonceBitmap`. Any unused nonce is valid, so an agent can hand out several
// consents at once; it cancels one it no longer wants with `cancelConsentNonces`.
import { hashStruct, keccak256, stringToHex, type Address, type Hex } from "viem";
import { CHARGE_DOMAIN_NAME, CHARGE_DOMAIN_VERSION } from "./charge.ts";
import { encodeAssetClass } from "./format.ts";
import type { LienView, OpenAssetParams, OpenParams, Terms } from "./types.ts";

/** A flat EIP-712 struct definition: one primary type, no nested struct members. */
type FlatTypes = Record<string, ReadonlyArray<{ name: string; type: string }>>;

/**
 * The EIP-712 `encodeType` string of a flat struct, e.g.
 * `Charge(uint256 lienId,uint256 amount,uint256 nonce,uint256 deadline)`. This is the exact
 * string the contract hashes into its typehash constant.
 */
export function eip712TypeString(types: FlatTypes): string {
  const entries = Object.entries(types);
  if (entries.length !== 1) throw new Error("eip712TypeString: expected exactly one struct");
  const [name, fields] = entries[0];
  return `${name}(${fields.map((f) => `${f.type} ${f.name}`).join(",")})`;
}

/** keccak256 of {@link eip712TypeString}: the contract's typehash for this struct. */
export function eip712TypeHash(types: FlatTypes): Hex {
  return keccak256(stringToHex(eip712TypeString(types)));
}

/**
 * The governance terms every open binds through `termsHash` (EncumbraGovernance.TERMS_TYPEHASH).
 * `oracle` is the zero address for same-token and title-backed liens.
 */
export const TERMS_TYPES = {
  Terms: [
    { name: "usageFeeBps", type: "uint16" },
    { name: "protocolFeeBps", type: "uint16" },
    { name: "keeperRewardBps", type: "uint16" },
    { name: "graceSecs", type: "uint32" },
    { name: "oracle", type: "address" },
    { name: "keeperModule", type: "address" },
  ],
} as const;

/** EncumbraGovernance.TERMS_TYPEHASH. */
export const TERMS_TYPEHASH: Hex = eip712TypeHash(TERMS_TYPES);

/**
 * The EIP-712 hashStruct of a set of terms: the `termsHash` that `open*` and both consents
 * carry. Equal to `EncumbraGovernance.openTerms(oraclePriced).termsHash` when given the values
 * governance reports (fees, grace, the oracle for a cross-token lien or zero, the keeper module).
 */
export function computeTermsHash(t: Terms): Hex {
  return hashStruct({
    types: TERMS_TYPES,
    primaryType: "Terms",
    data: {
      usageFeeBps: t.usageFeeBps,
      protocolFeeBps: t.protocolFeeBps,
      keeperRewardBps: t.keeperRewardBps,
      graceSecs: Number(t.graceSecs),
      oracle: t.oracle,
      keeperModule: t.keeperModule,
    },
  });
}

/** The terms a lien captured at open, read off its {@link LienView}. */
export function termsOfLien(l: Pick<LienView, keyof Terms>): Terms {
  return {
    usageFeeBps: l.usageFeeBps,
    protocolFeeBps: l.protocolFeeBps,
    keeperRewardBps: l.keeperRewardBps,
    graceSecs: l.graceSecs,
    oracle: l.oracle,
    keeperModule: l.keeperModule,
  };
}

export const OPEN_CONSENT_TYPES = {
  OpenConsent: [
    { name: "agent", type: "address" },
    { name: "owner", type: "address" },
    { name: "creditor", type: "address" },
    { name: "collateralToken", type: "address" },
    { name: "debtToken", type: "address" },
    { name: "collateralAmount", type: "uint256" },
    { name: "creditLimit", type: "uint256" },
    { name: "dueDate", type: "uint64" },
    { name: "liqThresholdBps", type: "uint16" },
    { name: "assetClass", type: "bytes32" },
    { name: "termsHash", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export const OPEN_ASSET_CONSENT_TYPES = {
  OpenAssetConsent: [
    { name: "agent", type: "address" },
    { name: "owner", type: "address" },
    { name: "creditor", type: "address" },
    { name: "nftToken", type: "address" },
    { name: "tokenId", type: "uint256" },
    { name: "debtToken", type: "address" },
    { name: "assetValue", type: "uint256" },
    { name: "creditLimit", type: "uint256" },
    { name: "dueDate", type: "uint64" },
    { name: "liqThresholdBps", type: "uint16" },
    { name: "assetClass", type: "bytes32" },
    { name: "termsHash", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/** The terms hash a lien opens on; every open path and both consents carry it. */
export function requireTermsHash(p: { termsHash?: Hex }): Hex {
  if (!p.termsHash || !/^0x[0-9a-fA-F]{64}$/.test(p.termsHash)) {
    throw new Error("termsHash is required: read the current one with EncumbraClient.currentTermsHash()");
  }
  return p.termsHash;
}

/**
 * The agent's consent to an installment schedule on a lien it is agent of but does not own
 * (`setLeaseSchedule`). The schedule is set once per lien, so the lien id is the replay guard.
 */
export const LEASE_SCHEDULE_TYPES = {
  LeaseSchedule: [
    { name: "lienId", type: "uint256" },
    { name: "installmentAmount", type: "uint256" },
    { name: "installmentPeriod", type: "uint64" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/** What the owner needs from the agent to submit `setLeaseSchedule` on the agent's lien. */
export type LeaseScheduleConsent = { deadline: bigint; signature: Hex };

export type LeaseScheduleTypedData = {
  domain: Domain;
  types: typeof LEASE_SCHEDULE_TYPES;
  primaryType: "LeaseSchedule";
  message: { lienId: bigint; installmentAmount: bigint; installmentPeriod: bigint; deadline: bigint };
};

/**
 * The typed data a lien's agent signs to agree to an installment schedule the owner sets.
 * An owner that is its own agent needs no signature.
 */
export function buildLeaseScheduleTypedData(
  c: { chainId: number | bigint; verifyingContract: Address },
  p: { lienId: bigint; installmentAmount: bigint; installmentPeriod: bigint | number; deadline: bigint },
): LeaseScheduleTypedData {
  return {
    domain: domain(c),
    types: LEASE_SCHEDULE_TYPES,
    primaryType: "LeaseSchedule",
    message: {
      lienId: p.lienId,
      installmentAmount: p.installmentAmount,
      installmentPeriod: BigInt(p.installmentPeriod),
      deadline: p.deadline,
    },
  };
}

/** Default validity of a consent: one hour. */
export const DEFAULT_CONSENT_TTL_SECONDS = 3600n;

/** What the owner needs from the agent to submit `openWithConsent` / `openAssetWithConsent`. */
export type OpenConsent = { nonce: bigint; deadline: bigint; signature: Hex };

type Domain = { name: string; version: string; chainId: number; verifyingContract: Address };

export type OpenConsentTypedData = {
  domain: Domain;
  types: typeof OPEN_CONSENT_TYPES;
  primaryType: "OpenConsent";
  message: {
    agent: Address;
    owner: Address;
    creditor: Address;
    collateralToken: Address;
    debtToken: Address;
    collateralAmount: bigint;
    creditLimit: bigint;
    dueDate: bigint;
    liqThresholdBps: number;
    assetClass: Hex;
    termsHash: Hex;
    nonce: bigint;
    deadline: bigint;
  };
};

export type OpenAssetConsentTypedData = {
  domain: Domain;
  types: typeof OPEN_ASSET_CONSENT_TYPES;
  primaryType: "OpenAssetConsent";
  message: {
    agent: Address;
    owner: Address;
    creditor: Address;
    nftToken: Address;
    tokenId: bigint;
    debtToken: Address;
    assetValue: bigint;
    creditLimit: bigint;
    dueDate: bigint;
    liqThresholdBps: number;
    assetClass: Hex;
    termsHash: Hex;
    nonce: bigint;
    deadline: bigint;
  };
};

export type ConsentContext = {
  chainId: number | bigint;
  verifyingContract: Address;
  /** The address that will submit the open and become the lien's owner. */
  owner: Address;
  nonce: bigint;
  deadline: bigint;
};

function domain(c: { chainId: number | bigint; verifyingContract: Address }): Domain {
  return {
    name: CHARGE_DOMAIN_NAME,
    version: CHARGE_DOMAIN_VERSION,
    chainId: Number(c.chainId),
    verifyingContract: c.verifyingContract,
  };
}

/**
 * The typed data an agent signs to agree to be named on a token lien with exactly these
 * terms. Defaults match `prepareOpenWithConsent`, so the owner must submit the same params.
 */
export function buildOpenConsentTypedData(c: ConsentContext, p: OpenParams): OpenConsentTypedData {
  return {
    domain: domain(c),
    types: OPEN_CONSENT_TYPES,
    primaryType: "OpenConsent",
    message: {
      agent: p.agent,
      owner: c.owner,
      creditor: p.creditor,
      collateralToken: p.collateralToken ?? p.token,
      debtToken: p.token,
      collateralAmount: p.collateral,
      creditLimit: p.creditLimit,
      dueDate: BigInt(p.dueDate ?? 0),
      liqThresholdBps: p.liqThresholdBps ?? 9000,
      assetClass: encodeAssetClass(p.assetClass ?? "agent-credit"),
      termsHash: requireTermsHash(p),
      nonce: c.nonce,
      deadline: c.deadline,
    },
  };
}

/** The typed data an agent signs to agree to be named on a title-backed lease. */
export function buildOpenAssetConsentTypedData(c: ConsentContext, p: OpenAssetParams): OpenAssetConsentTypedData {
  return {
    domain: domain(c),
    types: OPEN_ASSET_CONSENT_TYPES,
    primaryType: "OpenAssetConsent",
    message: {
      agent: p.agent,
      owner: c.owner,
      creditor: p.creditor,
      nftToken: p.nftToken,
      tokenId: p.tokenId,
      debtToken: p.token,
      assetValue: p.assetValue,
      creditLimit: p.creditLimit,
      dueDate: BigInt(p.dueDate ?? 0),
      liqThresholdBps: p.liqThresholdBps ?? 9000,
      assetClass: encodeAssetClass(p.assetClass ?? "equipment"),
      termsHash: requireTermsHash(p),
      nonce: c.nonce,
      deadline: c.deadline,
    },
  };
}

/** A fresh, uniformly random 256-bit consent nonce. */
export function randomConsentNonce(): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
}

/**
 * Group nonces into the (wordPos, mask) pairs `cancelConsentNonces` takes: one call per
 * bitmap word, each cancelling every listed nonce in that word.
 */
export function consentNonceMasks(nonces: readonly bigint[]): Array<{ wordPos: bigint; mask: bigint }> {
  const words = new Map<bigint, bigint>();
  for (const n of nonces) {
    if (n < 0n) throw new Error(`consent nonce must be non-negative, got ${n}`);
    words.set(n >> 8n, (words.get(n >> 8n) ?? 0n) | (1n << (n & 255n)));
  }
  return [...words].map(([wordPos, mask]) => ({ wordPos, mask }));
}

/** Whether `nonce` is marked in a bitmap word read from `consentNonceBitmap(agent, nonce >> 8)`. */
export function isNonceSet(word: bigint, nonce: bigint): boolean {
  return ((word >> (nonce & 255n)) & 1n) === 1n;
}
