// Smoke test for the built package: load dist/ the way a consumer does and call pure helpers.
// Run after `pnpm run build`: `node scripts/smoke.mjs`. Not shipped.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dist = new URL("../dist/", import.meta.url);
const sdk = await import(new URL("index.js", dist).href);
const abi = await import(new URL("abi.js", dist).href);

// computeTermsHash is hashStruct(Terms); the typehash is the deployed EncumbraGovernance one.
assert.equal(sdk.TERMS_TYPEHASH, "0x5534a6d8f9daa7c11b0b415288911aee70d5cd687dfb8f672db38ef36541996f");
const terms = {
  usageFeeBps: 50,
  protocolFeeBps: 200,
  keeperRewardBps: 100,
  graceSecs: 3600n,
  oracle: "0x00000000000000000000000000000000000000aa",
  keeperModule: "0x00000000000000000000000000000000000000bb",
};
const termsHash = sdk.computeTermsHash(terms);
assert.match(termsHash, /^0x[0-9a-f]{64}$/);
assert.notEqual(sdk.computeTermsHash({ ...terms, graceSecs: 3601n }), termsHash);

// x402 headers round-trip, bigints as decimal strings.
const header = sdk.encodeHeader({ x402Version: sdk.X402_VERSION, amount: 25n });
assert.deepEqual(sdk.decodeHeader(header), { x402Version: 2, amount: "25" });
assert.equal(sdk.chainIdOf("eip155:84532"), 84532n);

// An unsigned call encodes and decodes back.
const call = sdk.prepareRepay({ chainId: 84532, address: "0x00000000000000000000000000000000000000cc" }, 7n, 1_000_000n);
assert.equal(sdk.decodeEncumbraCalldata(call.data).functionName, "repay");

// The ./abi subpath carries the same ABI objects.
assert.equal(abi.encumbraLienAbi, sdk.encumbraLienAbi);

// Workers-safe: no top-level node: imports in the emitted JavaScript (x402 loads node:http lazily).
const distPath = fileURLToPath(dist);
for (const name of readdirSync(distPath).filter((n) => n.endsWith(".js"))) {
  const src = readFileSync(distPath + name, "utf8");
  assert.doesNotMatch(src, /^\s*import\s[^;]*["']node:/m, `${name} has a static node: import`);
  assert.doesNotMatch(src, /from\s*["']\.{1,2}\/[^"']+\.ts["']/, `${name} imports a .ts file`);
}
for (const name of readdirSync(distPath).filter((n) => n.endsWith(".d.ts"))) {
  assert.doesNotMatch(readFileSync(distPath + name, "utf8"), /["']\.{1,2}\/[^"']+\.ts["']/, `${name} references a .ts file`);
}

console.log(`smoke ok: ${Object.keys(sdk).length} exports, termsHash ${termsHash}, header ${header}`);
