// Regenerate src/abi.ts from the compiled contract artifacts.
//
// `pnpm compile` (repository root) writes every contract's ABI to build/artifacts.json. This
// script mirrors the ABIs the SDK exposes into one typed `as const` module so viem can infer
// argument and return types. Run `pnpm -C packages/sdk gen:abi` after recompiling.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const artifactsPath = join(here, "..", "..", "..", "build", "artifacts.json");
const outPath = join(here, "..", "src", "abi.ts");

/** Exported constant name -> contract name in build/artifacts.json. */
const EXPORTS: Array<[string, string]> = [
  ["encumbraLienAbi", "EncumbraLien"],
  ["encumbraGovernanceAbi", "EncumbraGovernance"],
  ["chainlinkPriceOracleAbi", "ChainlinkPriceOracle"],
  ["keeperBondAbi", "KeeperBond"],
  ["encumbraTokenAbi", "EncumbraToken"],
  ["encumbraAirdropAbi", "EncumbraAirdrop"],
  ["encumbraAuctionAbi", "EncumbraAuction"],
];

const artifacts = JSON.parse(readFileSync(artifactsPath, "utf8")) as Record<string, { abi?: unknown[] }>;

let out = `// GENERATED FILE: do not edit by hand.
// Source: build/artifacts.json (written by \`pnpm compile\`). Regenerate with
// \`pnpm -C packages/sdk gen:abi\`. Kept as \`as const\` so viem can infer types.
`;
for (const [name, contract] of EXPORTS) {
  const abi = artifacts[contract]?.abi;
  if (!Array.isArray(abi) || abi.length === 0) throw new Error(`No ${contract} ABI in ${artifactsPath}`);
  out += `\n/** ABI of ${contract}. */\nexport const ${name} = ${JSON.stringify(abi, null, 2)} as const;\n`;
  console.log(`${name}: ${abi.length} entries from ${contract}`);
}
writeFileSync(outPath, out);
console.log(`Wrote ${outPath}`);
