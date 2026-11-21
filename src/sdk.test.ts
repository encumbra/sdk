import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { encodeAbiParameters, keccak256, recoverTypedDataAddress, stringToHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  buildChargeTypedData,
  buildOpenAssetConsentTypedData,
  buildOpenConsentTypedData,
  consentNonceMasks,
  decodeAssetClass,
  decodeEncumbraCalldata,
  encodeAssetClass,
  isNonceSet,
  OPEN_ASSET_CONSENT_TYPES,
  OPEN_CONSENT_TYPES,
  prepareCancelConsentNonces,
  prepareCharge,
  prepareChargeWithAuth,
  prepareLiquidate,
  prepareOpen,
  prepareOpenAssetWithConsent,
  prepareOpenWithConsent,
  prepareWithdrawCreditor,
  prepareWithdrawCreditorTo,
  prepareCloseTo,
  randomConsentNonce,
  underwrite,
  buildLeaseScheduleTypedData,
  CHARGE_TYPES,
  computeTermsHash,
  decodeChangeArg,
  decodeGovernanceCalldata,
  decodeKeeperBondCalldata,
  eip712TypeHash,
  eip712TypeString,
  encumbraGovernanceAbi,
  encumbraLienAbi,
  keeperBondAbi,
  encumbraTokenAbi,
  encumbraAirdropAbi,
  encumbraAuctionAbi,
  chainlinkPriceOracleAbi,
  LEASE_SCHEDULE_TYPES,
  prepareCancelChange,
  prepareClearOracleFailure,
  prepareExecuteChange,
  prepareKeeperBond,
  prepareKeeperUnbond,
  prepareKeeperWithdraw,
  prepareMigrateOracle,
  preparePauseIntake,
  prepareProposeAdmin,
  prepareQueueMinCreditLimit,
  prepareQueueParams,
  prepareRecordExcuse,
  prepareReportOracleFailure,
  prepareRevokePendingAdmin,
  prepareSetLeaseSchedule,
  prepareSettleVouchers,
  prepareSlashMissed,
  prepareWithdrawProtocol,
  signVoucher,
  termsOfLien,
  TERMS_TYPEHASH,
  TERMS_TYPES,
  VOUCHER_TYPES,
  type AgentStats,
  type CallContext,
} from "./index.ts";

const CONTRACT = "0x00000000000000000000000000000000000000c0" as Address;
const CTX: CallContext = { chainId: 84532, address: CONTRACT };
const AGENT = "0x00000000000000000000000000000000000000a1" as Address;
const CREDITOR = "0x00000000000000000000000000000000000000c2" as Address;
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Address;
const TERMS = `0x${"7e".repeat(32)}` as Hex;

test("assetClass encodes and decodes round-trip", () => {
  const hex = encodeAssetClass("agent-credit");
  assert.equal(hex.length, 66); // 0x + 32 bytes
  assert.equal(decodeAssetClass(hex), "agent-credit");
  assert.equal(decodeAssetClass(`0x${"0".repeat(64)}` as Hex), "");
});

test("prepareCharge round-trips through the ABI decoder", () => {
  const call = prepareCharge(CTX, 7n, 1_000_000n);
  assert.equal(call.to, CONTRACT);
  assert.equal(call.value, "0x0");
  assert.equal(call.functionName, "charge");
  assert.equal(call.role, "creditor");
  const decoded = decodeEncumbraCalldata(call.data);
  assert.equal(decoded.functionName, "charge");
  assert.equal(decoded.args.id, "7");
  assert.equal(decoded.args.amount, "1000000");
});

test("prepareOpen encodes assetClass and decodes back to its tag", () => {
  const call = prepareOpen(CTX, {
    agent: AGENT,
    creditor: CREDITOR,
    token: USDC,
    collateral: 500n,
    creditLimit: 1000n,
    termsHash: TERMS,
  });
  assert.equal(call.functionName, "open");
  assert.equal(call.role, "owner");
  const decoded = decodeEncumbraCalldata(call.data);
  assert.equal(decoded.functionName, "open");
  assert.equal(decoded.args.assetClass, "agent-credit");
  assert.equal(decoded.args.liqThresholdBps, "9000");
  assert.equal(decoded.args.debtToken.toLowerCase(), USDC.toLowerCase());
});

test("prepareLiquidate is keeper-scoped and decodes", () => {
  const call = prepareLiquidate(CTX, 3n);
  assert.equal(call.role, "keeper");
  assert.equal(decodeEncumbraCalldata(call.data).args.id, "3");
});

test("creditor pull: withdrawCreditor and withdrawCreditorTo encode and decode", () => {
  const a = prepareWithdrawCreditor(CTX, USDC);
  assert.equal(a.functionName, "withdrawCreditor");
  assert.equal(a.role, "creditor");
  assert.equal(decodeEncumbraCalldata(a.data).args.token.toLowerCase(), USDC.toLowerCase());
  const b = prepareWithdrawCreditorTo(CTX, USDC, AGENT);
  const d = decodeEncumbraCalldata(b.data);
  assert.equal(d.functionName, "withdrawCreditorTo");
  assert.equal(d.args.to.toLowerCase(), AGENT.toLowerCase());
});

test("closeTo encodes the lien and the recipient for the owner", () => {
  const c = prepareCloseTo(CTX, 7n, AGENT);
  assert.equal(c.functionName, "closeTo");
  assert.equal(c.role, "owner");
  const d = decodeEncumbraCalldata(c.data);
  assert.equal(d.functionName, "closeTo");
  assert.equal(d.args.id, "7");
  assert.equal(d.args.to.toLowerCase(), AGENT.toLowerCase());
});

test("decodeEncumbraCalldata rejects unknown selectors", () => {
  assert.throws(() => decodeEncumbraCalldata("0xdeadbeef"));
});

test("Charge EIP-712 signature recovers to the agent (matches contract domain)", async () => {
  // A deterministic test key (never used for funds).
  const account = privateKeyToAccount(
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  );
  const typed = buildChargeTypedData({
    chainId: 84532,
    verifyingContract: CONTRACT,
    lienId: 7n,
    amount: 1_000_000n,
    nonce: 0n,
    deadline: 9_999_999_999n,
  });
  const signature = await account.signTypedData({
    domain: typed.domain,
    types: typed.types,
    primaryType: typed.primaryType,
    message: typed.message,
  });
  const recovered = await recoverTypedDataAddress({
    domain: typed.domain,
    types: typed.types,
    primaryType: typed.primaryType,
    message: typed.message,
    signature,
  });
  assert.equal(recovered.toLowerCase(), account.address.toLowerCase());

  // The creditor can then wrap that signature into a submittable call.
  const submit = prepareChargeWithAuth(CTX, 7n, 1_000_000n, 9_999_999_999n, signature);
  assert.equal(submit.functionName, "chargeWithAuth");
  const decoded = decodeEncumbraCalldata(submit.data);
  assert.equal(decoded.args.id, "7");
  assert.equal(decoded.args.signature.toLowerCase(), signature.toLowerCase());
});

test("underwrite tiers from on-chain history", () => {
  const clean: AgentStats = {
    liensOpened: 6n,
    liensSettled: 6n,
    liensDefaulted: 0n,
    totalRepaid: 10_000n,
    totalBadDebt: 0n,
    liensCuredLate: 0n,
  };
  const prime = underwrite({ stats: clean, collateralValue: 1000n });
  assert.equal(prime.tier, "Prime");
  assert.ok(prime.ltvBps > 10_000, "prime is under-collateralized");

  const defaulted: AgentStats = { ...clean, liensDefaulted: 1n, totalBadDebt: 5n };
  const restricted = underwrite({ stats: defaulted, collateralValue: 1000n });
  assert.equal(restricted.tier, "Restricted");
  assert.equal(restricted.creditLimit, 200n); // 2000 bps of 1000
});

// ---- agent consent at open ---------------------------------------------------------

// The well-known Hardhat/Anvil test account #1 key: public, never funded.
const AGENT_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // gitleaks:allow
const OWNER = "0x00000000000000000000000000000000000000b1" as Address;

/** A protocol source file, or null when the SDK is checked out without the contracts. */
function protocolSource(name: string): string | null {
  try {
    return readFileSync(new URL(`../../../contracts/${name}`, import.meta.url), "utf8");
  } catch {
    return null;
  }
}
const LIEN_SOURCE = protocolSource("EncumbraLien.sol");
const GOVERNANCE_SOURCE = protocolSource("EncumbraGovernance.sol");

/** The typehash string the contract hashes for `name`. */
function contractType(source: string, name: string): string {
  const m = new RegExp(`"(${name}\\([^"]*\\))"`).exec(source);
  assert.ok(m, `${name} typehash string not found in the contract`);
  return m[1];
}

test("every EIP-712 struct the SDK signs is the contract's typehash string, field for field", { skip: LIEN_SOURCE === null || GOVERNANCE_SOURCE === null }, () => {
  // When this fails the contract changed a struct: update the SDK's types to match.
  for (const types of [OPEN_CONSENT_TYPES, OPEN_ASSET_CONSENT_TYPES, LEASE_SCHEDULE_TYPES, CHARGE_TYPES, VOUCHER_TYPES]) {
    const name = Object.keys(types)[0];
    assert.equal(eip712TypeString(types), contractType(LIEN_SOURCE!, name), name);
  }
  assert.equal(eip712TypeString(TERMS_TYPES), contractType(GOVERNANCE_SOURCE!, "Terms"));
});

test("the typehashes match the contract's, and computeTermsHash is hashStruct(Terms)", () => {
  // EncumbraGovernance.TERMS_TYPEHASH as deployed.
  assert.equal(TERMS_TYPEHASH, "0x5534a6d8f9daa7c11b0b415288911aee70d5cd687dfb8f672db38ef36541996f");
  assert.equal(eip712TypeHash(LEASE_SCHEDULE_TYPES), keccak256(stringToHex("LeaseSchedule(uint256 lienId,uint256 installmentAmount,uint64 installmentPeriod,uint256 deadline)")));
  const terms = {
    usageFeeBps: 50,
    protocolFeeBps: 200,
    keeperRewardBps: 100,
    graceSecs: 3600n,
    oracle: "0x00000000000000000000000000000000000000aa" as Address,
    keeperModule: "0x00000000000000000000000000000000000000bb" as Address,
  };
  // keccak256(abi.encode(TERMS_TYPEHASH, t)), exactly as EncumbraGovernance.openTerms computes it.
  const expected = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint16" }, { type: "uint16" }, { type: "uint16" }, { type: "uint32" }, { type: "address" }, { type: "address" }],
      [TERMS_TYPEHASH, 50, 200, 100, 3600, terms.oracle, terms.keeperModule],
    ),
  );
  assert.equal(computeTermsHash(terms), expected);
  assert.notEqual(computeTermsHash({ ...terms, graceSecs: 3601n }), expected, "every term is bound");
  const lien = { ...terms, owner: AGENT, debt: 5n };
  assert.equal(computeTermsHash(termsOfLien(lien)), expected);
});

test("the open and lease calls take the signed fields in the ABI's parameter order", () => {
  const inputs = (fn: string) =>
    (encumbraLienAbi as readonly { type: string; name?: string; inputs?: readonly { name: string }[] }[]).find((e) => e.type === "function" && e.name === fn)!.inputs!.map((i) => i.name);
  // The ABI takes every signed field except `owner` (msg.sender), then the signature.
  assert.deepEqual(inputs("openWithConsent"), [...OPEN_CONSENT_TYPES.OpenConsent.map((f) => f.name).filter((f) => f !== "owner"), "agentSig"]);
  assert.deepEqual(inputs("openAssetWithConsent"), [...OPEN_ASSET_CONSENT_TYPES.OpenAssetConsent.map((f) => f.name).filter((f) => f !== "owner"), "agentSig"]);
  assert.deepEqual(inputs("setLeaseSchedule"), ["id", "installmentAmount", "installmentPeriod", "deadline", "agentSig"]);
});

test("the generated ABIs are the v1.1 contracts: no lien admin functions, governance and keeper bond present", () => {
  const fns = (abi: readonly { type: string; name?: string }[]) => new Set(abi.filter((e) => e.type === "function").map((e) => e.name!));
  const lien = fns(encumbraLienAbi);
  for (const gone of ["setParams", "setOracle", "setLiquidationGrace", "transferAdmin", "admin", "treasury", "MIN_ORACLE_FAILURE_PERIOD"]) {
    assert.equal(lien.has(gone), false, `EncumbraLien still has ${gone}`);
  }
  for (const added of ["withdrawCreditor", "withdrawCreditorTo", "withdrawProtocol", "reportOracleFailure", "clearOracleFailure", "migrateOracle", "oracleFailure", "pastDueSince", "closeTo", "governance"]) {
    assert.ok(lien.has(added), `EncumbraLien lacks ${added}`);
  }
  const gov = fns(encumbraGovernanceAbi);
  for (const f of ["queueParams", "queueMinCreditLimit", "execute", "cancel", "proposeAdmin", "acceptAdmin", "revokePendingAdmin", "pauseIntake", "termsForOpen", "minCreditLimit"]) assert.ok(gov.has(f), f);
  const kb = fns(keeperBondAbi);
  for (const f of ["bond", "requestUnbond", "withdraw", "slashMissed", "checkSlash", "keeperInfo"]) assert.ok(kb.has(f), f);
  for (const abi of [encumbraTokenAbi, encumbraAirdropAbi, encumbraAuctionAbi, chainlinkPriceOracleAbi]) assert.ok(abi.length > 0);
});

test("lien v1.1 calls encode and decode: protocol withdrawal, oracle escape, voucher batches", async () => {
  const w = decodeEncumbraCalldata(prepareWithdrawProtocol(CTX, USDC).data);
  assert.equal(w.functionName, "withdrawProtocol");
  assert.equal(prepareWithdrawProtocol(CTX, USDC).role, "anyone");
  for (const [call, fn] of [
    [prepareReportOracleFailure(CTX, 4n, "creditor"), "reportOracleFailure"],
    [prepareClearOracleFailure(CTX, 4n), "clearOracleFailure"],
    [prepareMigrateOracle(CTX, 4n), "migrateOracle"],
  ] as const) {
    const d = decodeEncumbraCalldata(call.data);
    assert.equal(d.functionName, fn);
    assert.equal(d.args.id, "4");
    assert.equal(call.contract, "EncumbraLien");
  }
  assert.equal(prepareReportOracleFailure(CTX, 4n, "creditor").role, "creditor");
  const agent = privateKeyToAccount(AGENT_KEY);
  const v = await signVoucher(agent, { chainId: 84532, verifyingContract: CONTRACT }, { id: 2n, cumulative: 30n, deadline: 99n });
  const batch = prepareSettleVouchers(CTX, [v, { ...v, id: 3n }]);
  const d = decodeEncumbraCalldata(batch.data);
  assert.equal(d.functionName, "settleVouchers");
  assert.match(d.args.vs, /"cumulative":"30"/);
  assert.equal(batch.args.ids, "2,3");
});

test("a lease schedule carries the agent's consent, or empty consent for an owner that is its agent", async () => {
  const agent = privateKeyToAccount(AGENT_KEY);
  const typed = buildLeaseScheduleTypedData({ chainId: 84532, verifyingContract: CONTRACT }, { lienId: 9n, installmentAmount: 500n, installmentPeriod: 2_592_000, deadline: 9_999_999_999n });
  assert.equal(typed.message.installmentPeriod, 2_592_000n);
  const signature = await agent.signTypedData(typed);
  assert.equal((await recoverTypedDataAddress({ ...typed, signature })).toLowerCase(), agent.address.toLowerCase());

  const withConsent = decodeEncumbraCalldata(prepareSetLeaseSchedule(CTX, 9n, 500n, 2_592_000, { deadline: 9_999_999_999n, signature }).data);
  assert.equal(withConsent.args.deadline, "9999999999");
  assert.equal(withConsent.args.agentSig.toLowerCase(), signature.toLowerCase());
  const own = decodeEncumbraCalldata(prepareSetLeaseSchedule(CTX, 9n, 500n, 2_592_000).data);
  assert.equal(own.args.deadline, "0");
  assert.equal(own.args.agentSig, "0x");
});

test("governance calls target the governance contract and decode per kind", () => {
  const GOV: CallContext = { chainId: 84532, address: "0x00000000000000000000000000000000000000d1" };
  const q = prepareQueueParams(GOV, { protocolFeeBps: 200, keeperRewardBps: 100, usageFeeBps: 50, treasury: CREDITOR, graceSecs: 3600 });
  assert.equal(q.to, GOV.address);
  assert.equal(q.contract, "EncumbraGovernance");
  assert.equal(q.role, "admin");
  assert.equal(decodeGovernanceCalldata(q.data).args._graceSecs, "3600");
  assert.throws(() => decodeEncumbraCalldata(q.data), "governance calldata is not lien calldata");

  assert.equal(decodeGovernanceCalldata(prepareExecuteChange(GOV, "MinCreditLimit").data).args.op, "5");
  assert.equal(prepareExecuteChange(GOV, "Params").role, "anyone");
  assert.equal(decodeGovernanceCalldata(prepareCancelChange(GOV, "Oracle", "council").data).args.op, "1");
  assert.equal(decodeGovernanceCalldata(prepareProposeAdmin(GOV, AGENT).data).functionName, "proposeAdmin");
  assert.equal(decodeGovernanceCalldata(prepareRevokePendingAdmin(GOV, "council").data).functionName, "revokePendingAdmin");
  assert.equal(decodeGovernanceCalldata(preparePauseIntake(GOV, 86_400, "council").data).args.duration, "86400");
  assert.equal(decodeGovernanceCalldata(prepareQueueMinCreditLimit(GOV, USDC, 1_000_000n).data).args.amount, "1000000");

  // The queued argument unpacks exactly as the contract packs it.
  const params = BigInt(CREDITOR) | (200n << 160n) | (100n << 176n) | (50n << 192n) | (3600n << 208n);
  assert.deepEqual(decodeChangeArg("Params", params), { op: "Params", treasury: CREDITOR, protocolFeeBps: 200, keeperRewardBps: 100, usageFeeBps: 50, graceSecs: 3600n });
  assert.deepEqual(decodeChangeArg("MinCreditLimit", BigInt(USDC) | (1_000_000n << 160n)), { op: "MinCreditLimit", token: USDC.toLowerCase(), amount: 1_000_000n });
  assert.deepEqual(decodeChangeArg("Oracle", BigInt(AGENT)), { op: "Oracle", address: AGENT });
});

test("keeper bond calls target the module and decode", () => {
  const KB: CallContext = { chainId: 84532, address: "0x00000000000000000000000000000000000000d2" };
  for (const [call, fn] of [
    [prepareKeeperBond(KB), "bond"],
    [prepareKeeperUnbond(KB), "requestUnbond"],
    [prepareKeeperWithdraw(KB), "withdraw"],
    [prepareSlashMissed(KB, 7n), "slashMissed"],
    [prepareRecordExcuse(KB, 7n), "recordExcuse"],
  ] as const) {
    assert.equal(call.contract, "KeeperBond");
    assert.equal(call.to, KB.address);
    assert.equal(decodeKeeperBondCalldata(call.data).functionName, fn);
  }
  assert.equal(prepareSlashMissed(KB, 7n).role, "anyone");
  assert.equal(decodeKeeperBondCalldata(prepareSlashMissed(KB, 7n).data).args.id, "7");
});

test("an agent's open consent signature recovers to the agent and wraps into openWithConsent", async () => {
  const agent = privateKeyToAccount(AGENT_KEY);
  const params = { agent: agent.address, creditor: CREDITOR, token: USDC, collateral: 500n, creditLimit: 1000n, termsHash: TERMS };
  const nonce = randomConsentNonce();
  const typed = buildOpenConsentTypedData(
    { chainId: 84532, verifyingContract: CONTRACT, owner: OWNER, nonce, deadline: 9_999_999_999n },
    params,
  );
  assert.equal(typed.message.owner, OWNER);
  assert.equal(typed.message.collateralToken, USDC, "collateral defaults to the debt token");
  assert.equal(typed.message.liqThresholdBps, 9000);
  assert.equal(decodeAssetClass(typed.message.assetClass), "agent-credit");
  const signature = await agent.signTypedData(typed);
  const recovered = await recoverTypedDataAddress({ ...typed, signature });
  assert.equal(recovered.toLowerCase(), agent.address.toLowerCase());

  const call = prepareOpenWithConsent(CTX, params, { nonce, deadline: 9_999_999_999n, signature });
  assert.equal(call.functionName, "openWithConsent");
  assert.equal(call.role, "owner");
  const decoded = decodeEncumbraCalldata(call.data);
  assert.equal(decoded.functionName, "openWithConsent");
  assert.equal(decoded.args.nonce, nonce.toString());
  assert.equal(decoded.args.agentSig.toLowerCase(), signature.toLowerCase());
  assert.equal(decoded.args.assetClass, "agent-credit");
  assert.equal(decoded.args.termsHash, TERMS);
  assert.throws(() => prepareOpen(CTX, { ...params, termsHash: undefined }), /termsHash is required/);

  // Plain open is only for an owner that is its own agent, and says so.
  assert.match(prepareOpen(CTX, params).summary, /as its own agent/);
});

test("a lease consent binds the title and wraps into openAssetWithConsent", async () => {
  const agent = privateKeyToAccount(AGENT_KEY);
  const lease = {
    agent: agent.address,
    creditor: CREDITOR,
    nftToken: "0x00000000000000000000000000000000000000f1" as Address,
    tokenId: 12n,
    token: USDC,
    assetValue: 80_000n,
    creditLimit: 60_000n,
    termsHash: TERMS,
  };
  const ctx = { chainId: 84532, verifyingContract: CONTRACT, owner: OWNER, nonce: 1n, deadline: 9_999_999_999n };
  const typed = buildOpenAssetConsentTypedData(ctx, lease);
  const signature = await agent.signTypedData(typed);
  const other = buildOpenAssetConsentTypedData(ctx, { ...lease, tokenId: 13n });
  const recoveredOther = await recoverTypedDataAddress({ ...other, signature });
  assert.notEqual(recoveredOther.toLowerCase(), agent.address.toLowerCase(), "a different title is a different message");

  const decoded = decodeEncumbraCalldata(prepareOpenAssetWithConsent(CTX, lease, { nonce: 1n, deadline: 9_999_999_999n, signature }).data);
  assert.equal(decoded.functionName, "openAssetWithConsent");
  assert.equal(decoded.args.tokenId, "12");
  assert.equal(decoded.args.assetClass, "equipment");
});

test("consent nonces group into bitmap words for cancellation", () => {
  const masks = consentNonceMasks([1n, 2n, 256n + 7n, 3n]);
  assert.deepEqual(masks, [
    { wordPos: 0n, mask: (1n << 1n) | (1n << 2n) | (1n << 3n) },
    { wordPos: 1n, mask: 1n << 7n },
  ]);
  assert.equal(isNonceSet(masks[0].mask, 2n), true);
  assert.equal(isNonceSet(masks[0].mask, 4n), false);
  const call = prepareCancelConsentNonces(CTX, masks[1].wordPos, masks[1].mask);
  assert.equal(call.role, "agent");
  assert.equal(decodeEncumbraCalldata(call.data).args.mask, String(1n << 7n));
  assert.throws(() => consentNonceMasks([-1n]));
});
