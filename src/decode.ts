// Decode EncumbraLien calldata into a human-readable confirmation.
//
// Confirmation text must come from the calldata, never from the caller's own summary of
// what it intends to do. A wallet (or a human approving an agent action) uses this to
// see exactly which function and arguments a transaction carries before signing.
import { decodeFunctionData, type Abi, type Hex } from "viem";
import { encumbraGovernanceAbi, encumbraLienAbi, keeperBondAbi } from "./abi.ts";
import { decodeAssetClass } from "./format.ts";

export type DecodedCall = {
  functionName: string;
  args: Record<string, string>;
  summary: string;
};

function inputNames(abi: Abi, functionName: string): string[] {
  const entry = abi.find(
    (e) => e.type === "function" && e.name === functionName,
  ) as { inputs?: ReadonlyArray<{ name: string; type: string }> } | undefined;
  return entry?.inputs?.map((i) => i.name) ?? [];
}

function stringify(name: string, value: unknown): string {
  // Render the assetClass bytes32 as its decoded tag for readability.
  if (name === "assetClass" && typeof value === "string" && value.startsWith("0x")) {
    try {
      return decodeAssetClass(value as Hex) || value;
    } catch {
      return value;
    }
  }
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value) || (typeof value === "object" && value !== null)) {
    return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  }
  return String(value);
}

function decodeWith(abi: Abi, data: Hex): DecodedCall {
  const { functionName, args } = decodeFunctionData({ abi, data });
  const names = inputNames(abi, functionName);
  const argList = (args ?? []) as readonly unknown[];
  const mapped: Record<string, string> = {};
  argList.forEach((v, i) => {
    const key = names[i] ?? `arg${i}`;
    mapped[key] = stringify(key, v);
  });
  const parts = Object.entries(mapped).map(([k, v]) => `${k}=${v}`);
  return { functionName, args: mapped, summary: `${functionName}(${parts.join(", ")})` };
}

/**
 * Decode EncumbraLien calldata. Throws if the selector is not a known EncumbraLien
 * function — callers should treat an unknown selector as a refusal, not a best guess.
 */
export function decodeEncumbraCalldata(data: Hex): DecodedCall {
  return decodeWith(encumbraLienAbi as Abi, data);
}

/** As {@link decodeEncumbraCalldata}, for EncumbraGovernance calldata. */
export function decodeGovernanceCalldata(data: Hex): DecodedCall {
  return decodeWith(encumbraGovernanceAbi as Abi, data);
}

/** As {@link decodeEncumbraCalldata}, for KeeperBond calldata. */
export function decodeKeeperBondCalldata(data: Hex): DecodedCall {
  return decodeWith(keeperBondAbi as Abi, data);
}
