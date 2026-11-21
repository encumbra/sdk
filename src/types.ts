// Shared value types for the Encumbra SDK.
import type { Address, Hex } from "viem";

export const STATUS = ["None", "Active", "Liquidated", "Closed"] as const;
export type LienStatus = (typeof STATUS)[number];

/**
 * Who is expected to sign a prepared call. Lien roles are `owner`, `agent`, `creditor` and
 * `keeper`; governance roles are `admin` and `council`; `anyone` marks a permissionless call
 * (executing a matured governance change, clearing a recovered oracle report).
 */
export type Role = "owner" | "agent" | "creditor" | "keeper" | "admin" | "council" | "anyone";

/** The contracts a {@link PreparedCall} can target. */
export type EncumbraContract = "EncumbraLien" | "EncumbraGovernance" | "KeeperBond";

export type LienView = {
  id: bigint;
  owner: Address;
  agent: Address;
  creditor: Address;
  collateralToken: Address;
  debtToken: Address;
  assetClass: string;
  collateral: bigint;
  debt: bigint;
  protocolAccrued: bigint;
  creditLimit: bigint;
  dueDate: bigint;
  liqThresholdBps: number;
  status: LienStatus;
  frozen: boolean;
  collateralIsNft: boolean;
  collateralTokenId: bigint;
  assetValue: bigint;
  installmentAmount: bigint;
  installmentPeriod: bigint;
  /** Sticky: the lien went past due at some point (a cured default if later settled). */
  everPastDue: boolean;
  // Terms captured at open. Governance changes never reach an existing lien, so fee math for
  // a lien uses these, not the governance globals.
  usageFeeBps: number;
  protocolFeeBps: number;
  keeperRewardBps: number;
  /** Past-due liquidation grace, seconds. */
  graceSecs: bigint;
  /** Price oracle captured at open; the zero address for same-token and title-backed liens. */
  oracle: Address;
  /** Keeper module captured at open; the zero address when none. */
  keeperModule: Address;
};

/** The governance terms a lien opens on (the EIP-712 struct `Terms`). */
export type Terms = {
  usageFeeBps: number;
  protocolFeeBps: number;
  keeperRewardBps: number;
  graceSecs: bigint;
  oracle: Address;
  keeperModule: Address;
};

/** A pending oracle-failure report on a lien (both zero when none). */
export type OracleFailure = {
  /** When the report was made, unix seconds; 0 when there is none. */
  since: bigint;
  /** The governance-approved oracle the lien may migrate to. */
  target: Address;
};

export type AgentStats = {
  liensOpened: bigint;
  liensSettled: bigint;
  liensDefaulted: bigint;
  totalRepaid: bigint;
  totalBadDebt: bigint;
  liensCuredLate: bigint;
};

export type LiquidationResult = {
  seized: bigint;
  toCreditor: bigint;
  keeperReward: bigint;
  protocolFee: bigint;
  surplusToOwner: bigint;
  residualBadDebt: bigint;
};

export type OpenParams = {
  agent: Address;
  creditor: Address;
  /** Settlement/debt token. */
  token: Address;
  /** Collateral token; defaults to `token` (same-asset lien). */
  collateralToken?: Address;
  collateral: bigint;
  creditLimit: bigint;
  /** 0 = open-ended. Unix seconds. */
  dueDate?: bigint | number;
  /** Default 9000 (90%). */
  liqThresholdBps?: number;
  /** Book tag; defaults to "agent-credit". */
  assetClass?: string;
  /**
   * EIP-712 hash of the governance terms the lien opens on (EncumbraGovernance.openTerms).
   * Every open and consent carries it; read it with {@link EncumbraClient.currentTermsHash}.
   */
  termsHash?: Hex;
};

export type OpenAssetParams = {
  agent: Address;
  creditor: Address;
  nftToken: Address;
  tokenId: bigint;
  /** Settlement/debt token. */
  token: Address;
  /** Appraised value in debt-token units. */
  assetValue: bigint;
  creditLimit: bigint;
  dueDate?: bigint | number;
  liqThresholdBps?: number;
  /** Defaults to "equipment". */
  assetClass?: string;
  /** As in {@link OpenParams.termsHash} (title leases use the same-token terms). */
  termsHash?: Hex;
};

/**
 * An unsigned transaction request plus a human-readable decode. Prepare-only tools
 * return this; a wallet (agent, creditor, keeper, admin, or a policy engine) signs and
 * broadcasts it. `to` is the contract named by `contract` (EncumbraLien when absent).
 */
export type PreparedCall = {
  chainId: number;
  to: Address;
  data: Hex;
  /** Encoded wei value; always "0x0" — Encumbra moves ERC-20/721, never native value. */
  value: Hex;
  /** The contract function this call invokes. */
  functionName: string;
  /** Decoded arguments, name -> stringified value (bigints as decimal strings). */
  args: Record<string, string>;
  /** One-line, wallet-ready description of what signing this will do. */
  summary: string;
  /** The role expected to sign/submit this call. */
  role: Role;
  /** The contract `to` points at. */
  contract?: EncumbraContract;
};

/** The EIP-712 typed data an agent signs to authorize a single draw (maps to ERC-7710/7715). */
export type ChargeTypedData = {
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: Address;
  };
  types: {
    Charge: ReadonlyArray<{ name: string; type: string }>;
  };
  primaryType: "Charge";
  message: {
    lienId: bigint;
    amount: bigint;
    nonce: bigint;
    deadline: bigint;
  };
};
