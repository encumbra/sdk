// Small formatting helpers shared by the SDK and consumers.
import { hexToString, stringToHex, type Hex } from "viem";
import { STATUS, type LienStatus } from "./types.ts";

const ZERO_BYTES32 = `0x${"0".repeat(64)}` as Hex;

/** Encode a short string as a right-padded bytes32 (matches the contract's assetClass). */
export function encodeAssetClass(s: string): Hex {
  if (new TextEncoder().encode(s).length > 32) {
    throw new Error(`assetClass "${s}" exceeds 32 bytes`);
  }
  return stringToHex(s, { size: 32 });
}

/** Decode a bytes32 assetClass back to its string, trimming trailing null padding. */
export function decodeAssetClass(hex: Hex): string {
  if (!hex || hex === ZERO_BYTES32) return "";
  // Strip trailing zero bytes, then decode. hexToString on the trimmed hex avoids
  // embedded/trailing NULs that would otherwise appear in the string.
  let h = hex.slice(2);
  while (h.length >= 2 && h.slice(-2) === "00") h = h.slice(0, -2);
  if (h.length === 0) return "";
  return hexToString(`0x${h}` as Hex);
}

export function statusName(status: number | bigint): LienStatus {
  return STATUS[Number(status)] ?? "None";
}

/** Health factor is WAD-scaled (1e18 = exactly at the liquidation threshold). */
export function formatHealthFactor(hf: bigint): string {
  if (hf >= 2n ** 255n) return "∞ (no debt)";
  return (Number(hf) / 1e18).toFixed(4);
}

/** Format a token amount given decimals, without pulling in a big-decimal dependency. */
export function formatUnits(amount: bigint, decimals: number): string {
  const neg = amount < 0n;
  const v = neg ? -amount : amount;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = v % base;
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole.toString()}${fracStr ? "." + fracStr : ""}`;
}
