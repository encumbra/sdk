// Prepare-only call builders for EncumbraGovernance.
//
// Every parameter new liens open on (fees, treasury, past-due grace, oracle, keeper module,
// minimum credit limit per debt token) changes through a queue: the admin queues a change,
// anyone executes it once `delay()` has passed and within `EXECUTION_WINDOW()`, and the admin
// (any kind) or the council (any kind but Council) can cancel it first. Existing liens keep the
// terms they captured at open. The admin role itself moves the same way: `proposeAdmin` queues
// the handover, `execute("Admin")` offers it, and the new admin accepts within the window.
import type { Abi, Address } from "viem";
import { encumbraGovernanceAbi } from "./abi.ts";
import { encodePrepared, type CallContext } from "./encode.ts";
import type { PreparedCall, Role } from "./types.ts";

/** Governance change kinds, in the contract's `Op` enum order. */
export const GOVERNANCE_OPS = { Params: 0, Oracle: 1, Council: 2, Admin: 3, KeeperModule: 4, MinCreditLimit: 5 } as const;
export type GovernanceOp = keyof typeof GOVERNANCE_OPS;

/** The queued change of one kind (all zero when none is queued). */
export type PendingChange = {
  /** Earliest execution time, unix seconds; 0 when nothing is queued. */
  eta: bigint;
  /** The admin epoch it was queued in; a change from an earlier epoch cannot execute. */
  epoch: bigint;
  /** The packed argument (see {@link decodeChangeArg}). */
  arg: bigint;
};

export type DecodedChange =
  | { op: "Params"; treasury: Address; protocolFeeBps: number; keeperRewardBps: number; usageFeeBps: number; graceSecs: bigint }
  | { op: "Oracle" | "Council" | "Admin" | "KeeperModule"; address: Address }
  | { op: "MinCreditLimit"; token: Address; amount: bigint };

const MASK160 = (1n << 160n) - 1n;
const MASK16 = (1n << 16n) - 1n;
const MASK32 = (1n << 32n) - 1n;

function addressOf(v: bigint): Address {
  return `0x${(v & MASK160).toString(16).padStart(40, "0")}`;
}

/** Unpack a queued change's `arg` as the contract packs it for each kind. */
export function decodeChangeArg(op: GovernanceOp, arg: bigint): DecodedChange {
  switch (op) {
    case "Params":
      return {
        op,
        treasury: addressOf(arg),
        protocolFeeBps: Number((arg >> 160n) & MASK16),
        keeperRewardBps: Number((arg >> 176n) & MASK16),
        usageFeeBps: Number((arg >> 192n) & MASK16),
        graceSecs: (arg >> 208n) & MASK32,
      };
    case "MinCreditLimit":
      return { op, token: addressOf(arg), amount: arg >> 160n };
    default:
      return { op, address: addressOf(arg) };
  }
}

function gov(ctx: CallContext, fn: string, args: readonly unknown[], human: Record<string, string>, role: Role, summary: string): PreparedCall {
  return encodePrepared(encumbraGovernanceAbi as Abi, "EncumbraGovernance", ctx, fn, args, human, role, summary);
}

/** Admin: queue new fees, treasury and past-due grace (all five restated together). */
export function prepareQueueParams(
  ctx: CallContext,
  p: { protocolFeeBps: number; keeperRewardBps: number; usageFeeBps: number; treasury: Address; graceSecs: bigint | number },
): PreparedCall {
  const grace = BigInt(p.graceSecs);
  return gov(
    ctx,
    "queueParams",
    [p.protocolFeeBps, p.keeperRewardBps, p.usageFeeBps, p.treasury, grace],
    {
      protocolFeeBps: String(p.protocolFeeBps),
      keeperRewardBps: String(p.keeperRewardBps),
      usageFeeBps: String(p.usageFeeBps),
      treasury: p.treasury,
      graceSecs: grace.toString(),
    },
    "admin",
    `Queue new terms for new liens: protocol fee ${p.protocolFeeBps} bps, keeper reward ${p.keeperRewardBps} bps, usage fee ${p.usageFeeBps} bps, past-due grace ${grace}s, treasury ${p.treasury}. Executable after the governance delay; existing liens are unaffected.`,
  );
}

/** Admin: queue the oracle new cross-token liens capture. */
export function prepareQueueOracle(ctx: CallContext, oracle: Address): PreparedCall {
  return gov(ctx, "queueOracle", [oracle], { oracle }, "admin", `Queue ${oracle} as the oracle new cross-token liens capture. Executable after the governance delay.`);
}

/** Admin: queue a council replacement (the zero address removes the council). */
export function prepareQueueCouncil(ctx: CallContext, council: Address): PreparedCall {
  return gov(ctx, "queueCouncil", [council], { council }, "admin", `Queue ${council} as the council. Executable after the governance delay.`);
}

/** Admin: queue the keeper module new liens capture (the zero address disables it for new liens). */
export function prepareQueueKeeperModule(ctx: CallContext, module: Address): PreparedCall {
  return gov(ctx, "queueKeeperModule", [module], { module }, "admin", `Queue ${module} as the keeper module new liens capture. Executable after the governance delay.`);
}

/** Admin: queue the minimum credit limit for new liens in `token` (0 removes it). */
export function prepareQueueMinCreditLimit(ctx: CallContext, token: Address, amount: bigint): PreparedCall {
  return gov(
    ctx,
    "queueMinCreditLimit",
    [token, amount],
    { token, amount: amount.toString() },
    "admin",
    `Queue a minimum credit limit of ${amount} for new liens in ${token}. Executable after the governance delay; existing liens are unaffected.`,
  );
}

/** Admin: queue an admin handover. After `execute("Admin")` the new admin has the execution window to accept. */
export function prepareProposeAdmin(ctx: CallContext, newAdmin: Address): PreparedCall {
  return gov(ctx, "proposeAdmin", [newAdmin], { newAdmin }, "admin", `Queue an admin handover to ${newAdmin}. After the delay it is offered; ${newAdmin} must then accept.`);
}

/** Anyone: apply the queued change of `op` once its delay has passed and before the execution window closes. */
export function prepareExecuteChange(ctx: CallContext, op: GovernanceOp): PreparedCall {
  return gov(ctx, "execute", [GOVERNANCE_OPS[op]], { op }, "anyone", `Execute the queued ${op} change. Permissionless; only valid after its delay and inside the execution window.`);
}

/** Admin (any kind) or council (any kind but Council): drop the queued change of `op`. */
export function prepareCancelChange(ctx: CallContext, op: GovernanceOp, role: Role = "admin"): PreparedCall {
  return gov(ctx, "cancel", [GOVERNANCE_OPS[op]], { op }, role, `Cancel the queued ${op} change. Admin, or the council for any kind but Council.`);
}

/** The pending admin takes the role (within the offer's expiry). */
export function prepareAcceptAdmin(ctx: CallContext): PreparedCall {
  return gov(ctx, "acceptAdmin", [], {}, "admin", `Accept the governance admin role. Only the pending admin, before the offer expires.`);
}

/** Admin or council: withdraw an outstanding admin offer. */
export function prepareRevokePendingAdmin(ctx: CallContext, role: Role = "admin"): PreparedCall {
  return gov(ctx, "revokePendingAdmin", [], {}, role, `Revoke the outstanding admin offer. Admin or council.`);
}

/** Admin or council: stop new liens from opening for `durationSecs` (existing liens keep working). */
export function preparePauseIntake(ctx: CallContext, durationSecs: bigint | number, role: Role = "admin"): PreparedCall {
  const d = BigInt(durationSecs);
  return gov(ctx, "pauseIntake", [d], { duration: d.toString() }, role, `Pause new lien intake for ${d}s. Existing liens are unaffected. Admin or council (the council's pauses are budgeted).`);
}

/** Admin: end an intake pause early. */
export function prepareUnpauseIntake(ctx: CallContext): PreparedCall {
  return gov(ctx, "unpauseIntake", [], {}, "admin", `End the intake pause now. Admin only; blocks council pauses for one governance delay.`);
}
