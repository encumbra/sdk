// EncumbraClient — the viem client agents and apps build around.
//
// Reads go through a viem PublicClient. Writes are prepare-only by default: every verb
// returns an unsigned PreparedCall for a wallet to sign. An optional WalletClient
// unlocks `exec()` for testnet end-to-end flows, constrained to this deployment's contracts
// (EncumbraLien, EncumbraGovernance, KeeperBond) and to write-allowed chains.
import {
  BaseError,
  ContractFunctionRevertedError,
  decodeErrorResult,
  parseEventLogs,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from "viem";
import { encumbraGovernanceAbi, encumbraLienAbi, keeperBondAbi } from "./abi.ts";
import { buildChargeTypedData, CHARGE_DOMAIN_NAME, CHARGE_DOMAIN_VERSION, DEFAULT_CHARGE_TTL_SECONDS } from "./charge.ts";
import {
  buildLeaseScheduleTypedData,
  buildOpenAssetConsentTypedData,
  buildOpenConsentTypedData,
  computeTermsHash,
  consentNonceMasks,
  DEFAULT_CONSENT_TTL_SECONDS,
  isNonceSet,
  randomConsentNonce,
  termsOfLien,
  type LeaseScheduleConsent,
  type LeaseScheduleTypedData,
  type OpenAssetConsentTypedData,
  type OpenConsent,
  type OpenConsentTypedData,
} from "./consent.ts";
import { decodeEncumbraCalldata, decodeGovernanceCalldata, decodeKeeperBondCalldata } from "./decode.ts";
import {
  prepareAddCollateral,
  prepareWithdrawCreditor,
  prepareWithdrawCreditorTo,
  prepareCancelConsentNonces,
  prepareCharge,
  prepareChargeWithAuth,
  prepareClearOracleFailure,
  prepareClose,
  prepareCloseTo,
  prepareFreeze,
  prepareLiquidate,
  prepareLiquidateAsset,
  prepareMigrateOracle,
  prepareOpen,
  prepareOpenAsset,
  prepareOpenAssetWithConsent,
  prepareOpenWithConsent,
  preparePayInstallment,
  prepareRepay,
  prepareReportOracleFailure,
  prepareSetLeaseSchedule,
  prepareSettleVouchers,
  prepareUnfreeze,
  prepareWithdrawProtocol,
  type CallContext,
} from "./encode.ts";
import {
  decodeChangeArg,
  GOVERNANCE_OPS,
  prepareAcceptAdmin,
  prepareCancelChange,
  prepareExecuteChange,
  preparePauseIntake,
  prepareProposeAdmin,
  prepareQueueCouncil,
  prepareQueueKeeperModule,
  prepareQueueMinCreditLimit,
  prepareQueueOracle,
  prepareQueueParams,
  prepareRevokePendingAdmin,
  prepareUnpauseIntake,
  type DecodedChange,
  type GovernanceOp,
  type PendingChange,
} from "./governance.ts";
import {
  prepareKeeperBond,
  prepareKeeperUnbond,
  prepareKeeperWithdraw,
  prepareRecordExcuse,
  prepareSlashMissed,
  type KeeperBondParams,
  type KeeperInfo,
  type SlashCheck,
} from "./keeper.ts";
import { decodeAssetClass, statusName } from "./format.ts";
import { isWriteAllowed } from "./chains.ts";
import type {
  AgentStats,
  ChargeTypedData,
  LienView,
  OpenAssetParams,
  OpenParams,
  OracleFailure,
  PreparedCall,
  Role,
  Terms,
} from "./types.ts";
import { VOUCHER_REJECTION, type SignedVoucher, type VoucherDomain } from "./voucher.ts";

/** The EIP-712 domain every agent signature for a deployment is made under. */
export type EncumbraDomain = { name: string; version: string; chainId: bigint; verifyingContract: Address };

/** A charge authorization as `chargeWithAuth` takes it (the nonce is the one the agent signed). */
export type ChargeAuth = { id: bigint; amount: bigint; nonce?: bigint; deadline: bigint; signature: Hex };

/** What a mined transaction sent through {@link EncumbraClient.execAndWait} reports. */
export type ExecResult = { hash: Hex; gasUsed: bigint; receipt: TransactionReceipt };

/** Outcome of one `settleVouchers` transaction, read from its receipt. */
export type SettleVouchersResult = {
  hash: Hex;
  gasUsed: bigint;
  settled: Array<{ id: bigint; cumulative: bigint; amount: bigint }>;
  rejected: Array<{ id: bigint; code: number; reason: string }>;
};

/** Governance state, read in one go. */
export type GovernanceState = {
  address: Address;
  admin: Address;
  council: Address;
  pendingAdmin: Address;
  pendingAdminExpiry: bigint;
  adminEpoch: bigint;
  delay: bigint;
  pausedUntil: bigint;
  councilPauseBlockedUntil: bigint;
  councilPauseUsed: bigint;
  treasury: Address;
  oracle: Address;
  keeperModule: Address;
  protocolFeeBps: number;
  keeperRewardBps: number;
  usageFeeBps: number;
  liquidationGraceSecs: bigint;
};

type RawTerms = {
  usageFeeBps: number;
  protocolFeeBps: number;
  keeperRewardBps: number;
  graceSecs: number;
  oracle: Address;
  keeperModule: Address;
};

function termsFromRaw(t: RawTerms): Terms {
  return {
    usageFeeBps: Number(t.usageFeeBps),
    protocolFeeBps: Number(t.protocolFeeBps),
    keeperRewardBps: Number(t.keeperRewardBps),
    graceSecs: BigInt(t.graceSecs),
    oracle: t.oracle,
    keeperModule: t.keeperModule,
  };
}

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
export type EncumbraClientOptions = {
  publicClient: PublicClient;
  /** The EncumbraLien contract. */
  address: Address;
  chainId: number;
  /** Optional: only needed for exec() (testnet signing). */
  walletClient?: WalletClient;
  /** EncumbraGovernance address; read from the lien (`governance()`) when omitted. */
  governance?: Address;
  /** KeeperBond address; read from governance (`keeperModule()`) when omitted. */
  keeperBond?: Address;
};

export class EncumbraClient {
  readonly address: Address;
  readonly chainId: number;
  private readonly pub: PublicClient;
  private readonly wallet?: WalletClient;
  private cachedDomainChainId?: bigint;
  private governanceAddr?: Address;
  private keeperBondAddr?: Address;

  constructor(opts: EncumbraClientOptions) {
    this.pub = opts.publicClient;
    this.address = opts.address;
    this.chainId = opts.chainId;
    this.wallet = opts.walletClient;
    this.governanceAddr = opts.governance;
    this.keeperBondAddr = opts.keeperBond;
    if (!this.address) throw new Error("EncumbraClient: contract address is required");
  }

  private ctx(): CallContext {
    return { chainId: this.chainId, address: this.address };
  }

  private readAt(address: Address, abi: Abi, functionName: string, args: readonly unknown[]): Promise<unknown> {
    return this.pub.readContract({ address, abi, functionName, args });
  }

  private read(functionName: string, args: readonly unknown[]): Promise<unknown> {
    return this.readAt(this.address, encumbraLienAbi as Abi, functionName, args);
  }

  private async readGov(functionName: string, args: readonly unknown[] = []): Promise<unknown> {
    return this.readAt(await this.governanceAddress(), encumbraGovernanceAbi as Abi, functionName, args);
  }

  private async readKeeper(functionName: string, args: readonly unknown[] = []): Promise<unknown> {
    return this.readAt(await this.keeperBondAddress(), keeperBondAbi as Abi, functionName, args);
  }

  // ---- reads ---------------------------------------------------------------

  async getLien(id: bigint): Promise<LienView> {
    const l = (await this.read("getLien", [id])) as {
      owner: Address;
      agent: Address;
      creditor: Address;
      collateralToken: Address;
      debtToken: Address;
      assetClass: Hex;
      collateral: bigint;
      debt: bigint;
      protocolAccrued: bigint;
      creditLimit: bigint;
      dueDate: bigint;
      liqThresholdBps: number;
      status: number;
      frozen: boolean;
      collateralIsNft: boolean;
      usageFeeBps: number;
      protocolFeeBps: number;
      keeperRewardBps: number;
      graceSecs: number;
      collateralTokenId: bigint;
      assetValue: bigint;
      installmentAmount: bigint;
      installmentPeriod: bigint;
      everPastDue: boolean;
      oracle: Address;
      keeperModule: Address;
    };
    return {
      id,
      owner: l.owner,
      agent: l.agent,
      creditor: l.creditor,
      collateralToken: l.collateralToken,
      debtToken: l.debtToken,
      assetClass: decodeAssetClass(l.assetClass),
      collateral: l.collateral,
      debt: l.debt,
      protocolAccrued: l.protocolAccrued,
      creditLimit: l.creditLimit,
      dueDate: l.dueDate,
      liqThresholdBps: Number(l.liqThresholdBps),
      status: statusName(l.status),
      frozen: l.frozen,
      collateralIsNft: l.collateralIsNft,
      collateralTokenId: l.collateralTokenId,
      assetValue: l.assetValue,
      installmentAmount: l.installmentAmount,
      installmentPeriod: l.installmentPeriod,
      everPastDue: l.everPastDue,
      usageFeeBps: Number(l.usageFeeBps),
      protocolFeeBps: Number(l.protocolFeeBps),
      keeperRewardBps: Number(l.keeperRewardBps),
      graceSecs: BigInt(l.graceSecs),
      oracle: l.oracle,
      keeperModule: l.keeperModule,
    };
  }

  async available(id: bigint): Promise<bigint> {
    return (await this.read("available", [id])) as bigint;
  }
  async isServiceable(id: bigint): Promise<boolean> {
    return (await this.read("isServiceable", [id])) as boolean;
  }
  async isAssetEnabled(id: bigint): Promise<boolean> {
    return (await this.read("isAssetEnabled", [id])) as boolean;
  }
  async isLiquidatable(id: bigint): Promise<boolean> {
    return (await this.read("isLiquidatable", [id])) as boolean;
  }
  async healthFactor(id: bigint): Promise<bigint> {
    return (await this.read("healthFactor", [id])) as bigint;
  }
  async collateralValue(id: bigint): Promise<bigint> {
    return (await this.read("collateralValue", [id])) as bigint;
  }
  async chargeNonce(id: bigint): Promise<bigint> {
    return (await this.read("chargeNonce", [id])) as bigint;
  }
  /** Held for `account` in `token` (creditor proceeds, owner liquidation surplus); paid out by withdrawCreditor. */
  async claimable(account: Address, token: Address): Promise<bigint> {
    return (await this.read("claimable", [account, token])) as bigint;
  }
  /** Protocol fees the lien holds in `token`, moved to the treasury by withdrawProtocol. */
  async protocolOwed(token: Address): Promise<bigint> {
    return (await this.read("protocolOwed", [token])) as bigint;
  }
  /** When past-due liquidation became legal (dueDate + grace), or 0. */
  async pastDueSince(id: bigint): Promise<bigint> {
    return (await this.read("pastDueSince", [id])) as bigint;
  }
  /** The pending oracle-failure report on a lien (since = 0 when there is none). */
  async oracleFailure(id: bigint): Promise<OracleFailure> {
    const r = (await this.read("oracleFailure", [id])) as readonly [bigint, Address];
    return { since: BigInt(r[0]), target: r[1] };
  }
  /** How long after a report the oracle migration window opens, seconds. */
  async oracleFailurePeriod(): Promise<bigint> {
    return (await this.read("oracleFailurePeriod", [])) as bigint;
  }
  /** How long the migration window stays open once it opens, seconds. */
  async oracleMigrationWindow(): Promise<bigint> {
    return (await this.read("oracleMigrationWindow", [])) as bigint;
  }
  /**
   * When a reported lien may migrate: `[opensAt, closesAt]` in unix seconds, or null when no
   * report is pending.
   */
  async oracleMigrationTimes(id: bigint): Promise<{ opensAt: bigint; closesAt: bigint } | null> {
    const [f, period, window] = await Promise.all([this.oracleFailure(id), this.oracleFailurePeriod(), this.oracleMigrationWindow()]);
    if (f.since === 0n) return null;
    return { opensAt: f.since + period, closesAt: f.since + period + window };
  }
  /** Cumulative amount already charged to this lien through vouchers. */
  async voucherSettled(id: bigint): Promise<bigint> {
    return (await this.read("voucherSettled", [id])) as bigint;
  }
  /** How far vouchers can still draw: the settled cursor and the largest cumulative that still fits. */
  async voucherRoom(id: bigint): Promise<{ settled: bigint; maxCumulative: bigint }> {
    const r = (await this.read("voucherRoom", [id])) as readonly [bigint, bigint];
    return { settled: BigInt(r[0]), maxCumulative: BigInt(r[1]) };
  }
  async nextId(): Promise<bigint> {
    return (await this.read("nextId", [])) as bigint;
  }

  /** The latest block's timestamp: the clock deadlines are checked against. */
  async now(): Promise<bigint> {
    return (await this.pub.getBlock()).timestamp;
  }

  /** Whether an agent's open-consent nonce is spent or cancelled. */
  async consentNonceUsed(agent: Address, nonce: bigint): Promise<boolean> {
    const word = (await this.read("consentNonceBitmap", [agent, nonce >> 8n])) as bigint;
    return isNonceSet(word, nonce);
  }

  /** The chainId the contract reports (block.chainid), used for the EIP-712 domain. */
  async onchainChainId(): Promise<bigint> {
    if (this.cachedDomainChainId === undefined) {
      this.cachedDomainChainId = (await this.read("chainId", [])) as bigint;
    }
    return this.cachedDomainChainId;
  }

  /** The EIP-712 domain every agent signature for this deployment is made under. */
  async domain(): Promise<EncumbraDomain> {
    return { name: CHARGE_DOMAIN_NAME, version: CHARGE_DOMAIN_VERSION, chainId: await this.onchainChainId(), verifyingContract: this.address };
  }

  /** The domain vouchers are signed under. */
  async voucherDomain(): Promise<VoucherDomain> {
    return { chainId: await this.onchainChainId(), verifyingContract: this.address };
  }

  async agentStats(agent: Address): Promise<AgentStats> {
    const s = (await this.read("agentStats", [agent])) as readonly bigint[];
    return {
      liensOpened: BigInt(s[0]),
      liensSettled: BigInt(s[1]),
      liensDefaulted: BigInt(s[2]),
      totalRepaid: BigInt(s[3]),
      totalBadDebt: BigInt(s[4]),
      liensCuredLate: BigInt(s[5]),
    };
  }

  /**
   * Scan liens [fromId, toId] and return the ids a keeper could liquidate now. When
   * `toId` is omitted it reads nextId and scans every created lien. Uses multicall3.
   */
  async listLiquidatable(fromId = 1n, toId?: bigint): Promise<bigint[]> {
    const end = toId ?? (await this.nextId()) - 1n;
    if (end < fromId) return [];
    const ids: bigint[] = [];
    for (let i = fromId; i <= end; i++) ids.push(i);
    // The ABI is widened to `Abi` here: inferring multicall's result types across the full
    // const ABI recurses past TypeScript's instantiation limit, and the result is cast below.
    const results = (await this.pub.multicall({
      allowFailure: true,
      contracts: ids.map((id) => ({
        address: this.address,
        abi: encumbraLienAbi as Abi,
        functionName: "isLiquidatable",
        args: [id],
      })),
    })) as Array<{ status: "success"; result: boolean } | { status: "failure"; error: Error }>;
    const out: bigint[] = [];
    results.forEach((r, i) => {
      if (r.status === "success" && r.result === true) out.push(ids[i]);
    });
    return out;
  }

  // ---- governance reads ----------------------------------------------------

  /** The EncumbraGovernance contract this lien registry reads its terms from. */
  async governanceAddress(): Promise<Address> {
    if (!this.governanceAddr) this.governanceAddr = (await this.read("governance", [])) as Address;
    return this.governanceAddr;
  }

  /**
   * The terms a new lien of this shape opens on and their hash (EncumbraGovernance.openTerms;
   * `oraclePriced` when collateral and debt tokens differ). Reverts while intake is paused.
   */
  async openTerms(oraclePriced: boolean): Promise<{ terms: Terms; termsHash: Hex }> {
    const r = (await this.readGov("openTerms", [oraclePriced])) as readonly [RawTerms, Hex];
    return { terms: termsFromRaw(r[0]), termsHash: r[1] };
  }

  /**
   * {@link openTerms} for a concrete lien, exactly as every open path checks it: also reverts
   * "below minimum" when `creditLimit` is under the debt token's minimum credit limit.
   */
  async termsForOpen(oraclePriced: boolean, debtToken: Address, creditLimit: bigint): Promise<{ terms: Terms; termsHash: Hex }> {
    const r = (await this.readGov("termsForOpen", [oraclePriced, debtToken, creditLimit])) as readonly [RawTerms, Hex];
    return { terms: termsFromRaw(r[0]), termsHash: r[1] };
  }

  /** The terms hash an open of this shape must carry right now. */
  async currentTermsHash(oraclePriced: boolean): Promise<Hex> {
    return (await this.openTerms(oraclePriced)).termsHash;
  }

  /** The hash of the terms a lien captured at open (fees, grace, oracle, keeper module). */
  async lienTermsHash(id: bigint): Promise<Hex> {
    return computeTermsHash(termsOfLien(await this.getLien(id)));
  }

  /** Smallest credit limit a new lien in `token` may open with (0 = none). */
  async minCreditLimit(token: Address): Promise<bigint> {
    return (await this.readGov("minCreditLimit", [token])) as bigint;
  }

  /** Every governance role, parameter and pause field. */
  async governanceState(): Promise<GovernanceState> {
    const address = await this.governanceAddress();
    const fields = [
      "admin",
      "council",
      "pendingAdmin",
      "pendingAdminExpiry",
      "adminEpoch",
      "delay",
      "pausedUntil",
      "councilPauseBlockedUntil",
      "councilPauseUsed",
      "treasury",
      "oracle",
      "keeperModule",
      "protocolFeeBps",
      "keeperRewardBps",
      "usageFeeBps",
      "liquidationGraceSecs",
    ] as const;
    const values = await Promise.all(fields.map((f) => this.readAt(address, encumbraGovernanceAbi as Abi, f, [])));
    const v = Object.fromEntries(fields.map((f, i) => [f, values[i]])) as Record<(typeof fields)[number], unknown>;
    return {
      address,
      admin: v.admin as Address,
      council: v.council as Address,
      pendingAdmin: v.pendingAdmin as Address,
      pendingAdminExpiry: BigInt(v.pendingAdminExpiry as bigint),
      adminEpoch: BigInt(v.adminEpoch as bigint),
      delay: BigInt(v.delay as bigint),
      pausedUntil: BigInt(v.pausedUntil as bigint),
      councilPauseBlockedUntil: BigInt(v.councilPauseBlockedUntil as bigint),
      councilPauseUsed: BigInt(v.councilPauseUsed as number),
      treasury: v.treasury as Address,
      oracle: v.oracle as Address,
      keeperModule: v.keeperModule as Address,
      protocolFeeBps: Number(v.protocolFeeBps),
      keeperRewardBps: Number(v.keeperRewardBps),
      usageFeeBps: Number(v.usageFeeBps),
      liquidationGraceSecs: BigInt(v.liquidationGraceSecs as number),
    };
  }

  /** The queued change of one kind, with its argument unpacked (null `change` when none is queued). */
  async pendingChange(op: GovernanceOp): Promise<PendingChange & { change: DecodedChange | null }> {
    const r = (await this.readGov("pending", [BigInt(GOVERNANCE_OPS[op])])) as readonly [bigint, bigint, bigint];
    const p = { eta: BigInt(r[0]), epoch: BigInt(r[1]), arg: BigInt(r[2]) };
    return { ...p, change: p.eta === 0n ? null : decodeChangeArg(op, p.arg) };
  }

  // ---- keeper bond reads ---------------------------------------------------

  /** The KeeperBond module: the configured one, else the keeper module governance hands new liens. */
  async keeperBondAddress(): Promise<Address> {
    if (!this.keeperBondAddr) {
      const m = (await this.readGov("keeperModule")) as Address;
      if (/^0x0{40}$/i.test(m)) throw new Error("no keeper module is configured in governance; pass keeperBond to the client");
      this.keeperBondAddr = m;
    }
    return this.keeperBondAddr;
  }

  async keeperInfo(keeper: Address): Promise<KeeperInfo> {
    const k = (await this.readKeeper("keeperInfo", [keeper])) as {
      bond: bigint;
      id: number;
      activeFrom: bigint;
      activeUntil: bigint;
      jailedAt: bigint;
      withdrawableAt: bigint;
    };
    return {
      bond: BigInt(k.bond),
      id: Number(k.id),
      activeFrom: BigInt(k.activeFrom),
      activeUntil: BigInt(k.activeUntil),
      jailedAt: BigInt(k.jailedAt),
      withdrawableAt: BigInt(k.withdrawableAt),
    };
  }

  async keeperBondParams(): Promise<KeeperBondParams> {
    const names = [
      "lien",
      "enc",
      "BOND",
      "SLOT",
      "WINDOW",
      "EPOCH",
      "ACTIVATION_EPOCHS",
      "REPORT_WINDOW",
      "UNBOND_COOLDOWN",
      "SLASH_BPS",
      "BOUNTY_BPS",
      "SLASH_TREASURY",
      "MAX_KEEPERS",
    ] as const;
    const address = await this.keeperBondAddress();
    const v = await Promise.all(names.map((n) => this.readAt(address, keeperBondAbi as Abi, n, [])));
    const n = (i: number) => BigInt(v[i] as bigint | number);
    return {
      lien: v[0] as Address,
      enc: v[1] as Address,
      bond: n(2),
      slot: n(3),
      window: n(4),
      epoch: n(5),
      activationEpochs: n(6),
      reportWindow: n(7),
      unbondCooldown: n(8),
      slashBps: n(9),
      bountyBps: n(10),
      slashTreasury: v[11] as Address,
      maxKeepers: n(12),
    };
  }

  async currentKeeperEpoch(): Promise<bigint> {
    return BigInt((await this.readKeeper("currentEpoch")) as bigint);
  }
  /** Whether `keeper` is in the active set of epoch `epoch`. */
  async isEligibleKeeper(keeper: Address, epoch: bigint): Promise<boolean> {
    return (await this.readKeeper("isEligible", [keeper, epoch])) as boolean;
  }
  /** The keeper holding the exclusive slot for lien `id` going past due at `pastDueAt` (zero when the set is empty). */
  async assignedKeeper(id: bigint, pastDueAt: bigint): Promise<Address> {
    return (await this.readKeeper("assignedKeeper", [id, pastDueAt])) as Address;
  }
  /** Dry run of slashMissed: `reason` is empty when a slash would succeed now. */
  async checkSlash(id: bigint): Promise<SlashCheck> {
    const r = (await this.readKeeper("checkSlash", [id])) as readonly [string, Address, bigint];
    return { reason: r[0], keeper: r[1], amount: BigInt(r[2]) };
  }
  async totalBonded(): Promise<bigint> {
    return BigInt((await this.readKeeper("totalBonded")) as bigint);
  }

  // ---- prepare (unsigned) --------------------------------------------------

  prepareOpen(p: OpenParams): PreparedCall {
    return prepareOpen(this.ctx(), p);
  }
  prepareOpenAsset(p: OpenAssetParams): PreparedCall {
    return prepareOpenAsset(this.ctx(), p);
  }
  prepareOpenWithConsent(p: OpenParams, consent: OpenConsent): PreparedCall {
    return prepareOpenWithConsent(this.ctx(), p, consent);
  }
  prepareOpenAssetWithConsent(p: OpenAssetParams, consent: OpenConsent): PreparedCall {
    return prepareOpenAssetWithConsent(this.ctx(), p, consent);
  }
  /** One call per bitmap word, cancelling every listed nonce of the sending agent. */
  prepareCancelConsents(nonces: readonly bigint[]): PreparedCall[] {
    return consentNonceMasks(nonces).map(({ wordPos, mask }) => prepareCancelConsentNonces(this.ctx(), wordPos, mask));
  }
  prepareCharge(id: bigint, amount: bigint): PreparedCall {
    return prepareCharge(this.ctx(), id, amount);
  }
  prepareChargeWithAuth(id: bigint, amount: bigint, deadline: bigint, signature: Hex): PreparedCall {
    return prepareChargeWithAuth(this.ctx(), id, amount, deadline, signature);
  }
  prepareRepay(id: bigint, amount: bigint): PreparedCall {
    return prepareRepay(this.ctx(), id, amount);
  }
  prepareWithdrawCreditor(token: Address): PreparedCall {
    return prepareWithdrawCreditor(this.ctx(), token);
  }
  prepareWithdrawCreditorTo(token: Address, to: Address): PreparedCall {
    return prepareWithdrawCreditorTo(this.ctx(), token, to);
  }
  prepareWithdrawProtocol(token: Address): PreparedCall {
    return prepareWithdrawProtocol(this.ctx(), token);
  }
  prepareAddCollateral(id: bigint, amount: bigint): PreparedCall {
    return prepareAddCollateral(this.ctx(), id, amount);
  }
  prepareFreeze(id: bigint, role: Role = "owner"): PreparedCall {
    return prepareFreeze(this.ctx(), id, role);
  }
  prepareUnfreeze(id: bigint, role: Role = "owner"): PreparedCall {
    return prepareUnfreeze(this.ctx(), id, role);
  }
  prepareLiquidate(id: bigint): PreparedCall {
    return prepareLiquidate(this.ctx(), id);
  }
  prepareLiquidateAsset(id: bigint): PreparedCall {
    return prepareLiquidateAsset(this.ctx(), id);
  }
  prepareClose(id: bigint): PreparedCall {
    return prepareClose(this.ctx(), id);
  }
  prepareCloseTo(id: bigint, to: Address): PreparedCall {
    return prepareCloseTo(this.ctx(), id, to);
  }
  preparePayInstallment(id: bigint): PreparedCall {
    return preparePayInstallment(this.ctx(), id);
  }
  /** Set a lease schedule; pass the agent's {@link LeaseScheduleConsent} unless the owner is the agent. */
  prepareSetLeaseSchedule(id: bigint, installmentAmount: bigint, installmentPeriod: bigint | number, consent?: LeaseScheduleConsent): PreparedCall {
    return prepareSetLeaseSchedule(this.ctx(), id, installmentAmount, installmentPeriod, consent);
  }
  prepareReportOracleFailure(id: bigint, role: Role = "owner"): PreparedCall {
    return prepareReportOracleFailure(this.ctx(), id, role);
  }
  prepareClearOracleFailure(id: bigint): PreparedCall {
    return prepareClearOracleFailure(this.ctx(), id);
  }
  prepareMigrateOracle(id: bigint, role: Role = "owner"): PreparedCall {
    return prepareMigrateOracle(this.ctx(), id, role);
  }
  prepareSettleVouchers(vouchers: readonly SignedVoucher[]): PreparedCall {
    return prepareSettleVouchers(this.ctx(), vouchers);
  }

  // ---- prepare governance (unsigned; resolves the governance address) -----

  private async govCtx(): Promise<CallContext> {
    return { chainId: this.chainId, address: await this.governanceAddress() };
  }
  async prepareQueueParams(p: Parameters<typeof prepareQueueParams>[1]): Promise<PreparedCall> {
    return prepareQueueParams(await this.govCtx(), p);
  }
  async prepareQueueOracle(oracle: Address): Promise<PreparedCall> {
    return prepareQueueOracle(await this.govCtx(), oracle);
  }
  async prepareQueueCouncil(council: Address): Promise<PreparedCall> {
    return prepareQueueCouncil(await this.govCtx(), council);
  }
  async prepareQueueKeeperModule(module: Address): Promise<PreparedCall> {
    return prepareQueueKeeperModule(await this.govCtx(), module);
  }
  async prepareQueueMinCreditLimit(token: Address, amount: bigint): Promise<PreparedCall> {
    return prepareQueueMinCreditLimit(await this.govCtx(), token, amount);
  }
  async prepareProposeAdmin(newAdmin: Address): Promise<PreparedCall> {
    return prepareProposeAdmin(await this.govCtx(), newAdmin);
  }
  async prepareExecuteChange(op: GovernanceOp): Promise<PreparedCall> {
    return prepareExecuteChange(await this.govCtx(), op);
  }
  async prepareCancelChange(op: GovernanceOp, role: Role = "admin"): Promise<PreparedCall> {
    return prepareCancelChange(await this.govCtx(), op, role);
  }
  async prepareAcceptAdmin(): Promise<PreparedCall> {
    return prepareAcceptAdmin(await this.govCtx());
  }
  async prepareRevokePendingAdmin(role: Role = "admin"): Promise<PreparedCall> {
    return prepareRevokePendingAdmin(await this.govCtx(), role);
  }
  async preparePauseIntake(durationSecs: bigint | number, role: Role = "admin"): Promise<PreparedCall> {
    return preparePauseIntake(await this.govCtx(), durationSecs, role);
  }
  async prepareUnpauseIntake(): Promise<PreparedCall> {
    return prepareUnpauseIntake(await this.govCtx());
  }

  // ---- prepare keeper bond (unsigned; resolves the module address) --------

  private async keeperCtx(): Promise<CallContext> {
    return { chainId: this.chainId, address: await this.keeperBondAddress() };
  }
  async prepareKeeperBond(): Promise<PreparedCall> {
    return prepareKeeperBond(await this.keeperCtx());
  }
  async prepareKeeperUnbond(): Promise<PreparedCall> {
    return prepareKeeperUnbond(await this.keeperCtx());
  }
  async prepareKeeperWithdraw(): Promise<PreparedCall> {
    return prepareKeeperWithdraw(await this.keeperCtx());
  }
  async prepareSlashMissed(id: bigint): Promise<PreparedCall> {
    return prepareSlashMissed(await this.keeperCtx(), id);
  }
  async prepareRecordExcuse(id: bigint): Promise<PreparedCall> {
    return prepareRecordExcuse(await this.keeperCtx(), id);
  }

  // ---- agent authorization (EIP-712) --------------------------------------

  /**
   * Build the typed data for the agent to sign to authorize one draw. Reads the lien's
   * current charge nonce and the contract's chainId so the signature verifies on-chain.
   * `nonceOverride` lets a caller build it offline when the nonce is already known.
   */
  async buildChargeAuth(
    lienId: bigint,
    amount: bigint,
    ttlSeconds: bigint = DEFAULT_CHARGE_TTL_SECONDS,
    nonceOverride?: bigint,
  ): Promise<ChargeTypedData> {
    const nonce = nonceOverride ?? (await this.chargeNonce(lienId));
    const cid = await this.onchainChainId();
    const deadline = BigInt(Math.floor(Date.now() / 1000)) + ttlSeconds;
    return buildChargeTypedData({ chainId: cid, verifyingContract: this.address, lienId, amount, nonce, deadline });
  }

  /**
   * Build the typed data the agent signs to agree to be named on a lien that `owner` opens
   * with exactly these terms. The terms hash defaults to the current governance terms, the
   * nonce to a random one (nonces are unordered) and the deadline to `ttlSeconds` from now.
   * The agent's signature, with the returned nonce and deadline, goes to the owner, who
   * submits {@link prepareOpenWithConsent} with the same params and `termsHash`.
   */
  async buildOpenConsent(
    p: OpenParams,
    owner: Address,
    opts: { nonce?: bigint; ttlSeconds?: bigint } = {},
  ): Promise<OpenConsentTypedData> {
    const termsHash = p.termsHash ?? (await this.currentTermsHash(!sameAddress(p.collateralToken ?? p.token, p.token)));
    return buildOpenConsentTypedData(await this.consentContext(owner, opts), { ...p, termsHash });
  }

  /** As {@link buildOpenConsent}, for a title-backed lease (same-token terms). */
  async buildOpenAssetConsent(
    p: OpenAssetParams,
    owner: Address,
    opts: { nonce?: bigint; ttlSeconds?: bigint } = {},
  ): Promise<OpenAssetConsentTypedData> {
    const termsHash = p.termsHash ?? (await this.currentTermsHash(false));
    return buildOpenAssetConsentTypedData(await this.consentContext(owner, opts), { ...p, termsHash });
  }

  /**
   * Build the typed data a lien's agent signs to agree to the installment schedule its owner
   * sets. The signature and the returned deadline go to {@link prepareSetLeaseSchedule}.
   */
  async buildLeaseScheduleConsent(
    lienId: bigint,
    installmentAmount: bigint,
    installmentPeriod: bigint | number,
    ttlSeconds: bigint = DEFAULT_CONSENT_TTL_SECONDS,
  ): Promise<LeaseScheduleTypedData> {
    return buildLeaseScheduleTypedData(
      { chainId: await this.onchainChainId(), verifyingContract: this.address },
      { lienId, installmentAmount, installmentPeriod, deadline: BigInt(Math.floor(Date.now() / 1000)) + ttlSeconds },
    );
  }

  private async consentContext(owner: Address, opts: { nonce?: bigint; ttlSeconds?: bigint }) {
    return {
      chainId: await this.onchainChainId(),
      verifyingContract: this.address,
      owner,
      nonce: opts.nonce ?? randomConsentNonce(),
      deadline: BigInt(Math.floor(Date.now() / 1000)) + (opts.ttlSeconds ?? DEFAULT_CONSENT_TTL_SECONDS),
    };
  }

  // ---- exec (optional, testnet-only) --------------------------------------

  get canExec(): boolean {
    return Boolean(this.wallet) && isWriteAllowed(this.chainId);
  }

  /** The address exec() sends from, when a wallet with an account is configured. */
  get execAccount(): Address | undefined {
    return this.wallet?.account?.address;
  }

  /** Decode `call.data` against the ABI of the contract it is addressed to; throws for anything else. */
  private async checkTarget(call: Pick<PreparedCall, "to" | "data">): Promise<void> {
    if (sameAddress(call.to, this.address)) {
      decodeEncumbraCalldata(call.data);
      return;
    }
    if (sameAddress(call.to, await this.governanceAddress())) {
      decodeGovernanceCalldata(call.data);
      return;
    }
    if (this.keeperBondAddr && sameAddress(call.to, this.keeperBondAddr)) {
      decodeKeeperBondCalldata(call.data);
      return;
    }
    let module: Address | undefined;
    try {
      module = await this.keeperBondAddress();
    } catch {
      module = undefined;
    }
    if (module && sameAddress(call.to, module)) {
      decodeKeeperBondCalldata(call.data);
      return;
    }
    throw new Error("refusing to exec a call not addressed to this deployment's EncumbraLien, EncumbraGovernance or KeeperBond");
  }

  /**
   * Simulate the call with eth_call, then sign and broadcast it with the configured
   * wallet. Refuses calls not addressed to this deployment's EncumbraLien, EncumbraGovernance
   * or KeeperBond (decoded against that contract's ABI) and chains outside the write
   * allowlist. Returns the transaction hash.
   */
  async exec(call: PreparedCall): Promise<Hex> {
    if (!this.wallet || !this.wallet.account) {
      throw new Error("exec requires a walletClient with an account");
    }
    if (!isWriteAllowed(this.chainId)) {
      throw new Error(`exec is disabled on chainId ${this.chainId} (write-allowed: testnet only)`);
    }
    await this.checkTarget(call);
    // Simulate first so we fail before spending gas on a revert.
    let gas: bigint;
    try {
      await this.pub.call({ account: this.wallet.account, to: call.to, data: call.data });
      gas = await this.pub.estimateGas({ account: this.wallet.account, to: call.to, data: call.data });
    } catch (err) {
      throw new Error(`simulation reverted: ${revertReason(err)}`);
    }
    // The gas limit is always set: a node-side default (90,000 on some nodes) is too low for an
    // open, and the contracts gate their external hooks and probes on gasleft(), so the limit
    // carries a 25% margin over the estimate.
    return this.wallet.sendTransaction({
      account: this.wallet.account,
      chain: this.wallet.chain,
      to: call.to,
      data: call.data,
      value: 0n,
      gas: (gas * 125n) / 100n,
    });
  }

  /** {@link exec}, then wait for the receipt. Throws when the transaction reverted on-chain. */
  async execAndWait(call: PreparedCall): Promise<ExecResult> {
    const hash = await this.exec(call);
    const receipt = await this.pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted`);
    return { hash, gasUsed: receipt.gasUsed, receipt };
  }

  /** Convenience: exec raw EncumbraLien calldata (decoded + simulated first). */
  async execData(data: Hex): Promise<Hex> {
    return this.exec({
      chainId: this.chainId,
      to: this.address,
      data,
      value: "0x0",
      functionName: "",
      args: {},
      summary: "",
      role: "keeper",
    });
  }

  /**
   * Creditor: submit an agent's charge authorization with the configured wallet and wait for
   * it to be mined. Simulation surfaces the contract's revert reason ("over limit", "past due",
   * "frozen", ...) before anything is broadcast.
   */
  async submitChargeAuth(auth: ChargeAuth): Promise<ExecResult> {
    return this.execAndWait(this.prepareChargeWithAuth(auth.id, auth.amount, auth.deadline, auth.signature));
  }

  /**
   * Creditor: settle the latest voucher of several liens in one transaction with the configured
   * wallet. The contract skips a voucher it cannot apply; those come back in `rejected`.
   */
  async settleVouchers(vouchers: readonly SignedVoucher[]): Promise<SettleVouchersResult> {
    const { hash, gasUsed, receipt } = await this.execAndWait(this.prepareSettleVouchers(vouchers));
    const ours = receipt.logs.filter((l) => sameAddress(l.address, this.address));
    const events = parseEventLogs({ abi: encumbraLienAbi as Abi, logs: ours, eventName: ["VoucherSettled", "VoucherRejected"] }) as unknown as Array<{
      eventName: "VoucherSettled" | "VoucherRejected";
      args: { id: bigint; cumulative?: bigint; amount?: bigint; code?: number };
    }>;
    const settled = events
      .filter((e) => e.eventName === "VoucherSettled")
      .map((e) => ({ id: e.args.id, cumulative: e.args.cumulative as bigint, amount: e.args.amount as bigint }));
    const rejected = events
      .filter((e) => e.eventName === "VoucherRejected")
      .map((e) => ({ id: e.args.id, code: Number(e.args.code), reason: VOUCHER_REJECTION[Number(e.args.code)] ?? "unknown" }));
    return { hash, gasUsed, settled, rejected };
  }
}

function revertReason(err: unknown): string {
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError && revert.reason) return revert.reason;
    // A plain eth_call: decode Error(string) / Panic(uint256) from the revert data a node returned.
    const withData = err.walk((e) => typeof (e as { data?: unknown }).data === "string" && /^0x[0-9a-fA-F]{8}/.test((e as { data: string }).data));
    if (withData) {
      try {
        const decoded = decodeErrorResult({ abi: [], data: (withData as unknown as { data: Hex }).data });
        if (decoded.errorName === "Error") return String(decoded.args?.[0] ?? "");
        if (decoded.errorName === "Panic") return `panic ${String(decoded.args?.[0] ?? "")}`;
      } catch {
        // not a standard error payload; fall through to the node's text
      }
    }
    const details = err.walk((e) => e instanceof BaseError && /revert/i.test(e.details ?? ""));
    if (details instanceof BaseError) {
      const m = /revert(?:ed)?:?\s*(.*)$/i.exec(details.details);
      if (m && m[1]) return m[1];
    }
    if (revert instanceof ContractFunctionRevertedError) return revert.shortMessage;
    return err.shortMessage;
  }
  return err instanceof Error ? err.message : String(err);
}
