// Prepare-only call builders.
//
// Every write verb has a `prepare*` function that returns an unsigned PreparedCall
// (calldata + a human decode) rather than broadcasting. A wallet — the agent's, the
// creditor's, a keeper's, or a policy engine — signs and submits it. This keeps keys
// out of the SDK and the MCP server, matching how Aave/Morpho/Pendle expose writes.
import { encodeFunctionData, type Abi, type Address, type Hex } from "viem";
import { encumbraLienAbi } from "./abi.ts";
import { encodeAssetClass } from "./format.ts";
import { requireTermsHash, type LeaseScheduleConsent, type OpenConsent } from "./consent.ts";
import type { EncumbraContract, OpenAssetParams, OpenParams, PreparedCall, Role } from "./types.ts";
import type { SignedVoucher } from "./voucher.ts";

/** Where a prepared call goes: the chain and the address of the contract it targets. */
export type CallContext = {
  chainId: number;
  address: Address;
};

function bps(v: string | number): string {
  return `${(Number(v) / 100).toFixed(2)}%`;
}

/** Encode one call to `abi` at `ctx.address` into a {@link PreparedCall}. */
export function encodePrepared(
  abi: Abi,
  contract: EncumbraContract,
  ctx: CallContext,
  functionName: string,
  argsForEncode: readonly unknown[],
  argsHuman: Record<string, string>,
  role: Role,
  summary: string,
): PreparedCall {
  const data = encodeFunctionData({ abi, functionName, args: argsForEncode }) as Hex;
  return {
    chainId: ctx.chainId,
    to: ctx.address,
    data,
    value: "0x0",
    functionName,
    args: argsHuman,
    summary,
    role,
    contract,
  };
}

function prepared(
  ctx: CallContext,
  functionName: string,
  argsForEncode: readonly unknown[],
  argsHuman: Record<string, string>,
  role: Role,
  summary: string,
): PreparedCall {
  return encodePrepared(encumbraLienAbi as Abi, "EncumbraLien", ctx, functionName, argsForEncode, argsHuman, role, summary);
}

function openTerms(ctx: CallContext, p: OpenParams) {
  const collateralToken = (p.collateralToken ?? p.token) as Address;
  const dueDate = BigInt(p.dueDate ?? 0);
  const liq = p.liqThresholdBps ?? 9000;
  const assetClass = p.assetClass ?? "agent-credit";
  return {
    encoded: [p.agent, p.creditor, collateralToken, p.token, p.collateral, p.creditLimit, dueDate, liq, encodeAssetClass(assetClass), requireTermsHash(p)],
    human: {
      agent: p.agent,
      creditor: p.creditor,
      collateralToken,
      debtToken: p.token,
      collateral: p.collateral.toString(),
      creditLimit: p.creditLimit.toString(),
      dueDate: dueDate.toString(),
      liqThresholdBps: String(liq),
      assetClass,
      termsHash: requireTermsHash(p),
    } as Record<string, string>,
    summary: `escrow ${p.collateral} collateral, extend a ${p.creditLimit} credit limit to agent ${p.agent}, liquidation threshold ${bps(liq)}. Requires a prior ERC-20 approval of ${p.collateral} to ${ctx.address}`,
  };
}

function openAssetTerms(p: OpenAssetParams) {
  const dueDate = BigInt(p.dueDate ?? 0);
  const liq = p.liqThresholdBps ?? 9000;
  const assetClass = p.assetClass ?? "equipment";
  return {
    encoded: [p.agent, p.creditor, p.nftToken, p.tokenId, p.token, p.assetValue, p.creditLimit, dueDate, liq, encodeAssetClass(assetClass), requireTermsHash(p)],
    human: {
      agent: p.agent,
      creditor: p.creditor,
      nftToken: p.nftToken,
      tokenId: p.tokenId.toString(),
      debtToken: p.token,
      assetValue: p.assetValue.toString(),
      creditLimit: p.creditLimit.toString(),
      dueDate: dueDate.toString(),
      liqThresholdBps: String(liq),
      assetClass,
      termsHash: requireTermsHash(p),
    } as Record<string, string>,
  };
}

/**
 * Open a lien with the submitting owner as its own agent. The contract refuses `open` when
 * `agent` is not the sender; to name another agent use {@link prepareOpenWithConsent}.
 */
export function prepareOpen(ctx: CallContext, p: OpenParams): PreparedCall {
  const t = openTerms(ctx, p);
  return prepared(
    ctx,
    "open",
    t.encoded,
    t.human,
    "owner",
    `Open a lien as its own agent (the sender must be ${p.agent}): ${t.summary}.`,
  );
}

/** Open a lien naming another agent, carrying the agent's signed {@link OpenConsent}. */
export function prepareOpenWithConsent(ctx: CallContext, p: OpenParams, consent: OpenConsent): PreparedCall {
  const t = openTerms(ctx, p);
  return prepared(
    ctx,
    "openWithConsent",
    [...t.encoded, consent.nonce, consent.deadline, consent.signature],
    { ...t.human, nonce: consent.nonce.toString(), deadline: consent.deadline.toString(), agentSig: consent.signature },
    "owner",
    `Open a lien with agent ${p.agent}'s signed consent (nonce ${consent.nonce}, valid until ${consent.deadline}): ${t.summary}. The sender must be the owner the agent signed for.`,
  );
}

/**
 * Open a title-backed lease with the submitting owner as its own agent. Naming another agent
 * needs {@link prepareOpenAssetWithConsent}.
 */
export function prepareOpenAsset(ctx: CallContext, p: OpenAssetParams): PreparedCall {
  const t = openAssetTerms(p);
  return prepared(
    ctx,
    "openAsset",
    t.encoded,
    t.human,
    "owner",
    `Open an asset-backed lease as its own agent (the sender must be ${p.agent}): escrow title ${p.nftToken}#${p.tokenId} (owner-declared value ${p.assetValue}), extend a ${p.creditLimit} limit. Requires approving the title to ${ctx.address} first.`,
  );
}

/** Open a title-backed lease naming another agent, carrying the agent's signed consent. */
export function prepareOpenAssetWithConsent(ctx: CallContext, p: OpenAssetParams, consent: OpenConsent): PreparedCall {
  const t = openAssetTerms(p);
  return prepared(
    ctx,
    "openAssetWithConsent",
    [...t.encoded, consent.nonce, consent.deadline, consent.signature],
    { ...t.human, nonce: consent.nonce.toString(), deadline: consent.deadline.toString(), agentSig: consent.signature },
    "owner",
    `Open an asset-backed lease with agent ${p.agent}'s signed consent (nonce ${consent.nonce}, valid until ${consent.deadline}): escrow title ${p.nftToken}#${p.tokenId} (owner-declared value ${p.assetValue}), extend a ${p.creditLimit} limit. Requires approving the title to ${ctx.address} first.`,
  );
}

/** The agent cancels unused consents: every nonce whose bit is set in `mask` at `wordPos`. */
export function prepareCancelConsentNonces(ctx: CallContext, wordPos: bigint, mask: bigint): PreparedCall {
  return prepared(
    ctx,
    "cancelConsentNonces",
    [wordPos, mask],
    { wordPos: wordPos.toString(), mask: mask.toString() },
    "agent",
    `Cancel the sender's open-consent nonces in bitmap word ${wordPos} (mask ${mask}). Consents with those nonces can no longer open a lien. Only affects the sender's own consents.`,
  );
}

export function prepareCharge(ctx: CallContext, lienId: bigint, amount: bigint): PreparedCall {
  return prepared(
    ctx,
    "charge",
    [lienId, amount],
    { id: lienId.toString(), amount: amount.toString() },
    "creditor",
    `Charge ${amount} of usage to lien #${lienId}. Fails if frozen, past due, or over the credit limit. Only the creditor can submit this.`,
  );
}

export function prepareChargeWithAuth(
  ctx: CallContext,
  lienId: bigint,
  amount: bigint,
  deadline: bigint,
  signature: Hex,
): PreparedCall {
  return prepared(
    ctx,
    "chargeWithAuth",
    [lienId, amount, deadline, signature],
    { id: lienId.toString(), amount: amount.toString(), deadline: deadline.toString(), signature },
    "creditor",
    `Charge ${amount} to lien #${lienId} using the agent's EIP-712 authorization (deadline ${deadline}). Only the creditor submits; the agent's signature is the consent.`,
  );
}

export function prepareRepay(ctx: CallContext, lienId: bigint, amount: bigint): PreparedCall {
  return prepared(
    ctx,
    "repay",
    [lienId, amount],
    { id: lienId.toString(), amount: amount.toString() },
    "owner",
    `Repay ${amount} on lien #${lienId} (creditor's share first, then protocol fees; both are held in the contract for withdrawal). Requires approving ${amount} to ${ctx.address}.`,
  );
}

/** Pay out everything the contract holds for the caller in `token` (creditor proceeds, owner surplus). */
export function prepareWithdrawCreditor(ctx: CallContext, token: Address): PreparedCall {
  return prepared(ctx, "withdrawCreditor", [token], { token }, "creditor", `Withdraw everything held for you in ${token}.`);
}

/** Same, paid to `to`, for a caller the token's issuer has blacklisted. */
export function prepareWithdrawCreditorTo(ctx: CallContext, token: Address, to: Address): PreparedCall {
  return prepared(ctx, "withdrawCreditorTo", [token, to], { token, to }, "creditor", `Withdraw everything held for you in ${token}, paid to ${to}.`);
}

export function prepareAddCollateral(ctx: CallContext, lienId: bigint, amount: bigint): PreparedCall {
  return prepared(
    ctx,
    "addCollateral",
    [lienId, amount],
    { id: lienId.toString(), amount: amount.toString() },
    "owner",
    `Add ${amount} collateral to lien #${lienId}. Requires approving ${amount} to ${ctx.address}.`,
  );
}

export function prepareFreeze(ctx: CallContext, lienId: bigint, role: Role = "owner"): PreparedCall {
  return prepared(
    ctx,
    "freeze",
    [lienId],
    { id: lienId.toString() },
    role,
    `Freeze lien #${lienId} (kill-switch): blocks new charges until unfrozen. Owner, agent, or creditor may do this.`,
  );
}

export function prepareUnfreeze(ctx: CallContext, lienId: bigint, role: Role = "owner"): PreparedCall {
  return prepared(
    ctx,
    "unfreeze",
    [lienId],
    { id: lienId.toString() },
    role,
    `Unfreeze lien #${lienId}: re-enable charges. Owner or creditor only.`,
  );
}

export function prepareLiquidate(ctx: CallContext, lienId: bigint): PreparedCall {
  return prepared(
    ctx,
    "liquidate",
    [lienId],
    { id: lienId.toString() },
    "keeper",
    `Liquidate defaulted lien #${lienId} (ERC-20 collateral). Permissionless; pays the keeper a senior reward. Reverts for title (non-fungible token) leases; use prepareLiquidateAsset for those.`,
  );
}

export function prepareLiquidateAsset(ctx: CallContext, lienId: bigint): PreparedCall {
  return prepared(
    ctx,
    "liquidateAsset",
    [lienId],
    { id: lienId.toString() },
    "keeper",
    `Repossess defaulted title (non-fungible token) lease #${lienId}: the keeper pays the owner-declared value, which nothing on-chain checks, and receives the title. Permissionless.`,
  );
}

export function prepareClose(ctx: CallContext, lienId: bigint): PreparedCall {
  return prepared(
    ctx,
    "close",
    [lienId],
    { id: lienId.toString() },
    "owner",
    `Close lien #${lienId} and return collateral/title. Requires debt == 0. Owner only.`,
  );
}

/** {@link prepareClose}, sending the collateral or title to `to` (for an owner the token's issuer has blacklisted). */
export function prepareCloseTo(ctx: CallContext, lienId: bigint, to: Address): PreparedCall {
  return prepared(
    ctx,
    "closeTo",
    [lienId, to],
    { id: lienId.toString(), to },
    "owner",
    `Close lien #${lienId} and send its collateral/title to ${to}. Requires debt == 0. Owner only.`,
  );
}

export function preparePayInstallment(ctx: CallContext, lienId: bigint): PreparedCall {
  return prepared(
    ctx,
    "payInstallment",
    [lienId],
    { id: lienId.toString() },
    "owner",
    `Pay the next installment on lease #${lienId} (rolls the due date forward). Anyone may pay.`,
  );
}

/**
 * Set an installment schedule (set once; the first payment is due one period out). An owner
 * that is its own agent passes no consent; otherwise pass the agent's signed
 * {@link LeaseScheduleConsent} (see `buildLeaseScheduleTypedData`).
 */
export function prepareSetLeaseSchedule(
  ctx: CallContext,
  lienId: bigint,
  installmentAmount: bigint,
  installmentPeriod: bigint | number,
  consent?: LeaseScheduleConsent,
): PreparedCall {
  const period = BigInt(installmentPeriod);
  const deadline = consent?.deadline ?? 0n;
  const agentSig: Hex = consent?.signature ?? "0x";
  return prepared(
    ctx,
    "setLeaseSchedule",
    [lienId, installmentAmount, period, deadline, agentSig],
    {
      id: lienId.toString(),
      installmentAmount: installmentAmount.toString(),
      installmentPeriod: period.toString(),
      deadline: deadline.toString(),
      agentSig,
    },
    "owner",
    consent
      ? `Set a lease schedule on lien #${lienId}: ${installmentAmount} every ${period}s, with the agent's signed consent (valid until ${deadline}). Set-once; owner only.`
      : `Set a lease schedule on lien #${lienId}: ${installmentAmount} every ${period}s. Set-once; only an owner that is also the lien's agent may submit it without the agent's consent.`,
  );
}

/** Move the protocol fees the lien holds in `token` to the governance treasury. Anyone may call. */
export function prepareWithdrawProtocol(ctx: CallContext, token: Address): PreparedCall {
  return prepared(
    ctx,
    "withdrawProtocol",
    [token],
    { token },
    "anyone",
    `Send the protocol fees held in ${token} to the governance treasury. Permissionless; moves nothing to the caller.`,
  );
}

/**
 * Report that a lien's captured oracle no longer prices its pair while governance approves a
 * different oracle. Owner or creditor. Starts the oracle-failure clock; {@link prepareMigrateOracle}
 * becomes valid `oracleFailurePeriod()` later, for `oracleMigrationWindow()`.
 */
export function prepareReportOracleFailure(ctx: CallContext, lienId: bigint, role: Role = "owner"): PreparedCall {
  return prepared(
    ctx,
    "reportOracleFailure",
    [lienId],
    { id: lienId.toString() },
    role,
    `Report that lien #${lienId}'s oracle is failing. Owner or creditor; only while the captured oracle fails and governance approves another.`,
  );
}

/** Clear a lien's oracle-failure report once its captured oracle answers again. Anyone may call. */
export function prepareClearOracleFailure(ctx: CallContext, lienId: bigint): PreparedCall {
  return prepared(
    ctx,
    "clearOracleFailure",
    [lienId],
    { id: lienId.toString() },
    "anyone",
    `Clear the oracle-failure report on lien #${lienId}; only valid while its captured oracle answers again.`,
  );
}

/**
 * Move a lien to the oracle named in its failure report. Owner or creditor, only inside the
 * migration window that opens `oracleFailurePeriod()` after the report.
 */
export function prepareMigrateOracle(ctx: CallContext, lienId: bigint, role: Role = "owner"): PreparedCall {
  return prepared(
    ctx,
    "migrateOracle",
    [lienId],
    { id: lienId.toString() },
    role,
    `Migrate lien #${lienId} to the oracle named in its failure report. Owner or creditor; only inside the migration window.`,
  );
}

/** The argument shape of the contract's `Voucher` struct. */
function voucherArg(v: SignedVoucher) {
  return { id: v.id, cumulative: v.cumulative, deadline: v.deadline, ref: v.ref, r: v.r, s: v.s, v: v.v };
}

/** Creditor settles one agent-signed voucher: charges the lien the difference from what is already settled. */
export function prepareSettleVoucher(ctx: CallContext, v: SignedVoucher): PreparedCall {
  return prepared(
    ctx,
    "settleVoucher",
    [voucherArg(v)],
    { id: v.id.toString(), cumulative: v.cumulative.toString(), deadline: v.deadline.toString(), ref: v.ref },
    "creditor",
    `Settle the agent's voucher on lien #${v.id} up to a running total of ${v.cumulative}. Only the creditor can submit this.`,
  );
}

/** Creditor settles a batch of vouchers in one transaction; a voucher the contract refuses is skipped and reported. */
export function prepareSettleVouchers(ctx: CallContext, vs: readonly SignedVoucher[]): PreparedCall {
  return prepared(
    ctx,
    "settleVouchers",
    [vs.map(voucherArg)],
    { count: String(vs.length), ids: vs.map((v) => v.id.toString()).join(",") },
    "creditor",
    `Settle ${vs.length} agent-signed voucher(s) in one transaction. Only the creditor of each lien can settle it; others are rejected in the receipt.`,
  );
}
