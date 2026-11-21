// Prepare-only call builders for KeeperBond, the bonded keeper module.
//
// A keeper bonds exactly `BOND()` ENC (approve it to the module first) and joins the active set
// `ACTIVATION_EPOCHS()` epochs later. Each past-due lien that captured this module gets one
// assigned keeper with an exclusive slot; a keeper that misses its slot can be slashed by anyone
// (`slashMissed`), with a bounty to the caller. `checkSlash` is the dry run. Leaving is
// `requestUnbond`, then `withdraw` once the cooldown has passed. The module has no owner.
import type { Abi, Address } from "viem";
import { keeperBondAbi } from "./abi.ts";
import { encodePrepared, type CallContext } from "./encode.ts";
import type { PreparedCall, Role } from "./types.ts";

/** A keeper's position in the module (`keeperInfo`). */
export type KeeperInfo = {
  bond: bigint;
  id: number;
  activeFrom: bigint;
  activeUntil: bigint;
  jailedAt: bigint;
  withdrawableAt: bigint;
};

/** The module's immutable parameters. */
export type KeeperBondParams = {
  lien: Address;
  enc: Address;
  bond: bigint;
  slot: bigint;
  window: bigint;
  epoch: bigint;
  activationEpochs: bigint;
  reportWindow: bigint;
  unbondCooldown: bigint;
  slashBps: bigint;
  bountyBps: bigint;
  slashTreasury: Address;
  maxKeepers: bigint;
};

/** Result of `checkSlash`: `reason` is empty when a slash would succeed now. */
export type SlashCheck = { reason: string; keeper: Address; amount: bigint };

function kb(ctx: CallContext, fn: string, args: readonly unknown[], human: Record<string, string>, role: Role, summary: string): PreparedCall {
  return encodePrepared(keeperBondAbi as Abi, "KeeperBond", ctx, fn, args, human, role, summary);
}

/** Bond exactly `BOND()` ENC; requires approving that amount to the module first. */
export function prepareKeeperBond(ctx: CallContext): PreparedCall {
  return kb(ctx, "bond", [], {}, "keeper", `Bond the module's fixed ENC amount and join the keeper set after the activation delay. Requires approving BOND() ENC to ${ctx.address} first.`);
}

/** Schedule leaving the keeper set; duties already assigned stay slashable. */
export function prepareKeeperUnbond(ctx: CallContext): PreparedCall {
  return kb(ctx, "requestUnbond", [], {}, "keeper", `Schedule leaving the keeper set. Duties already assigned remain slashable; the bond unlocks after the cooldown.`);
}

/** Take the (possibly slashed) bond back once the exit is scheduled and the cooldown has passed. */
export function prepareKeeperWithdraw(ctx: CallContext): PreparedCall {
  return kb(ctx, "withdraw", [], {}, "keeper", `Withdraw the bond after an unbond request and its cooldown.`);
}

/** Anyone: slash the assigned keeper of lien `id` for missing its slot (check with `checkSlash` first). */
export function prepareSlashMissed(ctx: CallContext, lienId: bigint): PreparedCall {
  return kb(ctx, "slashMissed", [lienId], { id: lienId.toString() }, "anyone", `Slash the keeper assigned to lien #${lienId} for missing its slot; the caller receives the bounty. Reverts with a kb: reason when no slash is due.`);
}

/** Record an objective reason liquidation of lien `id` is impossible right now, blocking a slash for this duty. */
export function prepareRecordExcuse(ctx: CallContext, lienId: bigint): PreparedCall {
  return kb(ctx, "recordExcuse", [lienId], { id: lienId.toString() }, "keeper", `Record why lien #${lienId} cannot be liquidated right now (oracle, paused token or sequencer), excusing its assigned keeper.`);
}
