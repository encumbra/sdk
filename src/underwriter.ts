// The credit-limit oracle — a transparent, rules-based reference underwriter.
//
// Turning an agent's on-chain repayment history into a credit limit is Encumbra's
// defensible core: settlement (x402) and identity (ERC-8004) are commoditizing, but
// underwriting compounds with every lien. This mirrors src/underwriter.ts so agents
// and the MCP server can recommend a limit from `agentStats` without a chain write.
import type { AgentStats } from "./types.ts";

export type UnderwriteInput = {
  stats: AgentStats;
  /** In debt-token units. */
  collateralValue: bigint;
  /** 0..1, e.g. an ERC-8004 reputation score. Optional. */
  externalReputation?: number;
};

export type UnderwriteResult = {
  /** Recommended credit limit, in debt-token units. */
  creditLimit: bigint;
  /** limit / collateralValue in bps (>10000 ⇒ under-collateralized). */
  ltvBps: number;
  tier: "Restricted" | "New" | "Established" | "Trusted" | "Prime";
  rationale: string;
};

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Recommend a credit limit from an agent's on-chain track record. */
export function underwrite(input: UnderwriteInput): UnderwriteResult {
  const { stats, collateralValue } = input;
  const extRep = clamp01(input.externalReputation ?? 0);

  // A single default flips the agent to collateral-only, pending a clean recovery.
  if (stats.liensDefaulted > 0n) {
    const ltvBps = stats.totalBadDebt > 0n ? 2000 : 3000;
    return {
      creditLimit: (collateralValue * BigInt(ltvBps)) / 10_000n,
      ltvBps,
      tier: "Restricted",
      rationale: `${stats.liensDefaulted} prior default(s)${stats.totalBadDebt > 0n ? " with bad debt" : ""}; collateral-only until a clean record is rebuilt.`,
    };
  }

  const settled = Number(stats.liensSettled);
  let tier: UnderwriteResult["tier"];
  let baseLtv: number;
  if (settled === 0) {
    tier = "New";
    baseLtv = 5000;
  } else if (settled <= 2) {
    tier = "Established";
    baseLtv = 9000;
  } else if (settled <= 4) {
    tier = "Trusted";
    baseLtv = 11000;
  } else {
    tier = "Prime";
    baseLtv = 15000;
  }

  const ltvBps = Math.round(baseLtv * (1 + 0.3 * extRep));
  const creditLimit = (collateralValue * BigInt(ltvBps)) / 10_000n;
  const undercoll = ltvBps > 10_000 ? ` (under-collateralized: credit extended beyond collateral)` : "";
  return {
    creditLimit,
    ltvBps,
    tier,
    rationale: `${settled} clean settlement(s), 0 defaults${extRep > 0 ? `, ext. reputation ${extRep.toFixed(2)}` : ""} → ${tier} tier at ${(ltvBps / 100).toFixed(0)}% LTV${undercoll}.`,
  };
}
