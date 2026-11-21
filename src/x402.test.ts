// x402 v2 paid from a lien, against an in-memory ledger that applies the contract's rules for
// charges and vouchers (signature, nonce, deadline, room, freeze, creditor), so it runs with no
// chain or RPC endpoint.
import { test } from "node:test";
import assert from "node:assert/strict";
import { recoverTypedDataAddress, zeroAddress, type Address, type Hex, type TransactionReceipt } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  CHARGE_TYPES,
  LienPayer,
  SCHEME_LIEN,
  SCHEME_VOUCHER,
  X402_ERRORS as ERRORS,
  HEADER_RESPONSE,
  HEADER_SIGNATURE,
  VoucherMeter,
  chainIdOf,
  decodeHeader,
  encodeHeader,
  recoverVoucherSigner,
  serveMeteredResource,
  signLienPayment,
  signVoucher,
  splitVoucherSignature,
  voucherSignature,
  x402Fetch,
  type ChargeAuth,
  type EncumbraDomain,
  type LienView,
  type PaymentRequirements,
  type SettleVouchersResult,
  type SettlementResponse,
  type SignedVoucher,
} from "./index.ts";

const U = 1_000_000n;
const CONTRACT = "0x00000000000000000000000000000000000000c0" as Address;
const USDC = "0x036cbd53842c5426634e7929541ec2318f3dcf7e" as Address;
const OTHER = "0x00000000000000000000000000000000000000e7" as Address;
const CREDITOR = "0x00000000000000000000000000000000000000c2" as Address;
const SOMEONE_ELSE = "0x00000000000000000000000000000000000000c3" as Address;
const agent = privateKeyToAccount("0x6cbed15c793ce57650b9877cf6fa156fbef513c4e6134f022a85b1ffdd59b2a1");
const stranger = privateKeyToAccount("0x6370fd033278c143179d81c5526140625662b8daa446c22ee2d73db3707e620c");

type Lien = { agent: Address; creditor: Address; debtToken: Address; creditLimit: bigint; debt: bigint; nonce: bigint; settled: bigint; frozen: boolean; status: LienView["status"] };

/** A ledger with the contract's charge and voucher rules, counting reads and writes like a chain would see them. */
class Ledger {
  readonly execAccount: Address = CREDITOR;
  liens = new Map<bigint, Lien>();
  time = 1_800_000_000n;
  reads = 0;
  sends = 0;
  private tx = 0;

  open(l: Partial<Lien> & { creditLimit: bigint }): bigint {
    const id = BigInt(this.liens.size + 1);
    this.liens.set(id, { agent: agent.address, creditor: CREDITOR, debtToken: USDC, debt: 0n, nonce: 0n, settled: 0n, frozen: false, status: "Active", ...l });
    return id;
  }
  private lien(id: bigint): Lien {
    const l = this.liens.get(id);
    if (!l) throw new Error("no lien");
    return l;
  }
  private hash(): Hex {
    return `0x${(++this.tx).toString(16).padStart(64, "0")}`;
  }

  async domain(): Promise<EncumbraDomain> {
    this.reads++;
    return { name: "Encumbra", version: "1", chainId: 84532n, verifyingContract: CONTRACT };
  }
  async now(): Promise<bigint> {
    this.reads++;
    return this.time;
  }
  async getLien(id: bigint): Promise<LienView> {
    this.reads++;
    const l = this.lien(id);
    return {
      id,
      owner: zeroAddress,
      agent: l.agent,
      creditor: l.creditor,
      collateralToken: l.debtToken,
      debtToken: l.debtToken,
      assetClass: "agent-credit",
      collateral: 0n,
      debt: l.debt,
      protocolAccrued: 0n,
      creditLimit: l.creditLimit,
      dueDate: 0n,
      liqThresholdBps: 9000,
      status: l.status,
      frozen: l.frozen,
      collateralIsNft: false,
      collateralTokenId: 0n,
      assetValue: 0n,
      installmentAmount: 0n,
      installmentPeriod: 0n,
      everPastDue: false,
      usageFeeBps: 0,
      protocolFeeBps: 0,
      keeperRewardBps: 0,
      graceSecs: 0n,
      oracle: zeroAddress,
      keeperModule: zeroAddress,
    };
  }
  async chargeNonce(id: bigint): Promise<bigint> {
    this.reads++;
    return this.lien(id).nonce;
  }
  async isServiceable(id: bigint): Promise<boolean> {
    this.reads++;
    const l = this.lien(id);
    return l.status === "Active" && !l.frozen;
  }
  async available(id: bigint): Promise<bigint> {
    this.reads++;
    const l = this.lien(id);
    return l.creditLimit - l.debt;
  }
  async voucherSettled(id: bigint): Promise<bigint> {
    this.reads++;
    return this.lien(id).settled;
  }
  async voucherRoom(id: bigint): Promise<{ settled: bigint; maxCumulative: bigint }> {
    this.reads++;
    const l = this.lien(id);
    return { settled: l.settled, maxCumulative: l.status === "Active" && !l.frozen ? l.settled + l.creditLimit - l.debt : l.settled };
  }
  async submitChargeAuth(a: ChargeAuth) {
    this.sends++;
    const l = this.lien(a.id);
    const signer = await recoverTypedDataAddress({
      domain: { name: "Encumbra", version: "1", chainId: 84532, verifyingContract: CONTRACT },
      types: CHARGE_TYPES,
      primaryType: "Charge",
      message: { lienId: a.id, amount: a.amount, nonce: l.nonce, deadline: a.deadline },
      signature: a.signature,
    });
    if (signer.toLowerCase() !== l.agent.toLowerCase()) throw new Error("simulation reverted: bad auth");
    if (l.frozen) throw new Error("simulation reverted: frozen");
    if (l.debt + a.amount > l.creditLimit) throw new Error("simulation reverted: over limit");
    l.debt += a.amount;
    l.nonce++;
    return { hash: this.hash(), gasUsed: 60_000n, receipt: {} as TransactionReceipt };
  }
  async settleVouchers(vs: readonly SignedVoucher[]): Promise<SettleVouchersResult> {
    this.sends++;
    const out: SettleVouchersResult = { hash: this.hash(), gasUsed: 40_000n * BigInt(vs.length), settled: [], rejected: [] };
    for (const v of vs) {
      const l = this.lien(v.id);
      const signer = await recoverVoucherSigner({ chainId: 84532n, verifyingContract: CONTRACT }, v);
      const code =
        l.status !== "Active" ? 1 : l.creditor !== CREDITOR ? 2 : l.frozen ? 3 : v.deadline < this.time ? 5 : v.cumulative <= l.settled ? 6
        : l.debt + v.cumulative - l.settled > l.creditLimit ? 7 : signer?.toLowerCase() !== l.agent.toLowerCase() ? 8 : 0;
      if (code) {
        out.rejected.push({ id: v.id, code, reason: ({ 1: "not active", 2: "not creditor", 3: "frozen", 5: "voucher expired", 6: "stale voucher", 7: "over limit", 8: "bad agent signature" } as Record<number, string>)[code] });
        continue;
      }
      const amount = v.cumulative - l.settled;
      l.debt += amount;
      l.settled = v.cumulative;
      out.settled.push({ id: v.id, cumulative: v.cumulative, amount });
    }
    return out;
  }
}

const DOMAIN = { chainId: 84532n, verifyingContract: CONTRACT };

async function lienServer(creditLimit = 30n * U, price = 10n * U) {
  const chain = new Ledger();
  const id = chain.open({ creditLimit });
  const server = await serveMeteredResource({ encumbra: chain, price, asset: USDC, creditor: CREDITOR, handle: (q) => ({ q: q.get("q") }) });
  const payer = (signer = agent, lienId = id) => new LienPayer({ lienId, signer, prefer: SCHEME_LIEN, now: () => chain.time });
  return { chain, id, server, payer, price };
}

async function voucherServer(opts: { creditLimit?: bigint; liens?: number; maxUnsettled?: bigint; batchSize?: number } = {}) {
  const chain = new Ledger();
  const ids = Array.from({ length: opts.liens ?? 1 }, () => chain.open({ creditLimit: opts.creditLimit ?? 600n * U }));
  const meter = new VoucherMeter({ encumbra: chain, creditor: CREDITOR, token: USDC, domain: DOMAIN, now: () => Number(chain.time), maxUnsettled: opts.maxUnsettled, batchSize: opts.batchSize });
  const sign = (id: bigint, cumulative: bigint, who = agent, deadline?: bigint) => signVoucher(who, DOMAIN, { id, cumulative, deadline: deadline ?? chain.time + 86_400n });
  const serve = (handle: () => unknown = () => ({})) =>
    serveMeteredResource({ encumbra: chain, price: 10_000n, asset: USDC, creditor: CREDITOR, handle, meter, offerLien: false });
  const payer = (id: bigint, signer = agent) => new LienPayer({ lienId: id, signer, now: () => chain.time });
  return { chain, ids, meter, sign, serve, payer, PRICE: 10_000n };
}

test("headers are base64 JSON in both alphabets, and networks are CAIP-2", () => {
  const value = { x402Version: 2, amount: 10n, note: "ü/+?" };
  const std = encodeHeader(value);
  assert.match(std, /^[A-Za-z0-9+/]+=*$/);
  assert.deepEqual(decodeHeader(std), { x402Version: 2, amount: "10", note: "ü/+?" });
  const urlSafe = std.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  assert.deepEqual(decodeHeader(urlSafe), decodeHeader(std));
  assert.equal(encodeHeader(value), Buffer.from(JSON.stringify({ x402Version: 2, amount: "10", note: "ü/+?" })).toString("base64"));
  assert.equal(chainIdOf("eip155:84532"), 84532n);
  assert.throws(() => chainIdOf("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"));
  assert.throws(() => decodeHeader("not base64 json"));
});

test("a voucher signature splits into r, s, v and recovers to the agent", async () => {
  const v = await signVoucher(agent, DOMAIN, { id: 3n, cumulative: 5n, deadline: 9n });
  assert.ok(v.v === 27 || v.v === 28);
  assert.equal(v.ref, `0x${"0".repeat(64)}`);
  assert.deepEqual(splitVoucherSignature(voucherSignature(v)), { r: v.r, s: v.s, v: v.v });
  assert.equal((await recoverVoucherSigner(DOMAIN, v))?.toLowerCase(), agent.address.toLowerCase());
  assert.notEqual((await recoverVoucherSigner(DOMAIN, { ...v, cumulative: 6n }))?.toLowerCase(), agent.address.toLowerCase());
  assert.equal(await recoverVoucherSigner(DOMAIN, { ...v, r: `0x${"0".repeat(64)}` }), null);
});

test("encumbra-lien: each request carries a signed charge that settles before it is served", async () => {
  const { chain, server, payer, id, price } = await lienServer();
  try {
    const first = await x402Fetch(`${server.url}/feed`);
    assert.equal(first.status, 402);
    const offer = first.required!.accepts[0];
    assert.equal(offer.scheme, SCHEME_LIEN);
    assert.equal(offer.network, "eip155:84532");
    const p = payer();
    for (let i = 1; i <= 3; i++) {
      const r = await p.get(`${server.url}/feed?q=${i}`);
      assert.equal(r.status, 200, r.error);
      assert.deepEqual(r.data, { q: String(i) });
      assert.equal(r.settlement?.success, true);
      assert.equal(r.settlement?.payer?.toLowerCase(), agent.address.toLowerCase());
      assert.equal(r.settlement?.amount, price.toString());
      assert.match(r.settlement?.transaction ?? "", /^0x[0-9a-f]{64}$/);
    }
    assert.equal(chain.liens.get(id)!.debt, 3n * price);
    assert.equal(chain.liens.get(id)!.nonce, 3n);
  } finally {
    await server.close();
  }
});

test("encumbra-lien: a stale nonce is corrected by the server and re-signed once", async () => {
  const { chain, server, payer, id } = await lienServer();
  try {
    await payer().get(`${server.url}/feed`);
    await payer().get(`${server.url}/feed`);
    const r = await payer().get(`${server.url}/feed`);
    assert.equal(r.status, 200, r.error);
    assert.equal(chain.liens.get(id)!.nonce, 3n);
  } finally {
    await server.close();
  }
});

test("encumbra-lien: a used-up line answers 402 insufficient_funds until it is repaid; strangers cannot spend it", async () => {
  const { chain, server, payer, id, price } = await lienServer();
  try {
    const p = payer();
    for (let i = 0; i < 3; i++) assert.equal((await p.get(`${server.url}/feed`)).status, 200);
    const cut = await p.get(`${server.url}/feed`);
    assert.equal(cut.status, 402);
    assert.equal(cut.settlement?.errorReason, ERRORS.insufficientFunds);
    assert.equal(chain.liens.get(id)!.debt, 3n * price);
    chain.liens.get(id)!.debt = 0n;
    assert.equal((await p.get(`${server.url}/feed`)).status, 200);

    const s = await payer(stranger).get(`${server.url}/feed`);
    assert.equal(s.status, 402);
    assert.equal(s.settlement?.errorReason, ERRORS.lienSignature);
    assert.equal(s.required?.accepts[0].extra.chargeNonce, undefined, "no correction for a payer that is not the agent");
  } finally {
    await server.close();
  }
});

test("encumbra-lien: a lien in another token, or an expired authorization, is refused", async () => {
  const { chain, server } = await lienServer();
  try {
    const wrongToken = chain.open({ creditLimit: 60n * U, debtToken: OTHER });
    const r1 = await new LienPayer({ lienId: wrongToken, signer: agent, prefer: SCHEME_LIEN, now: () => chain.time }).get(`${server.url}/feed`);
    assert.equal(r1.settlement?.errorReason, ERRORS.lienUnusable);
    assert.match(r1.settlement?.errorMessage ?? "", /different token/);

    const offer = (await x402Fetch(`${server.url}/feed`)).required!.accepts[0];
    const expired = await signLienPayment(offer, { lienId: 1n, nonce: 0n, deadline: chain.time - 1n, signer: agent });
    assert.equal((await x402Fetch(`${server.url}/feed`, expired)).settlement?.errorReason, ERRORS.lienDeadline);
  } finally {
    await server.close();
  }
});

test("a payment that changes the offer, the version or the scheme is refused; garbage is a 400", async () => {
  const { chain, server } = await lienServer();
  try {
    const offer = (await x402Fetch(`${server.url}/feed`)).required!.accepts[0];
    const pay = (req: PaymentRequirements) => signLienPayment(req, { lienId: 1n, nonce: 0n, deadline: chain.time + 60n, signer: agent });
    assert.equal((await x402Fetch(`${server.url}/feed`, await pay({ ...offer, amount: "1" }))).settlement?.errorReason, ERRORS.invalidRequirements);
    assert.equal((await x402Fetch(`${server.url}/feed`, { ...(await pay(offer)), x402Version: 1 })).settlement?.errorReason, ERRORS.invalidVersion);
    assert.equal((await x402Fetch(`${server.url}/feed`, await pay({ ...offer, scheme: SCHEME_VOUCHER }))).settlement?.errorReason, ERRORS.unsupportedScheme);
    const garbage = await fetch(`${server.url}/feed`, { headers: { [HEADER_SIGNATURE]: "not base64 json" } });
    assert.equal(garbage.status, 400);
    assert.equal(decodeHeader<SettlementResponse>(garbage.headers.get(HEADER_RESPONSE)!).errorReason, ERRORS.invalidPayload);
  } finally {
    await server.close();
  }
});

test("a server checks its meter's token and that its wallet is the creditor", async () => {
  const chain = new Ledger();
  const meter = new VoucherMeter({ encumbra: chain, creditor: CREDITOR, token: USDC, domain: DOMAIN });
  const server = await serveMeteredResource({ encumbra: chain, price: 1n, asset: USDC, creditor: CREDITOR, handle: () => 1, meter });
  try {
    assert.deepEqual((await x402Fetch(`${server.url}/x`)).required?.accepts.map((a) => a.scheme), [SCHEME_VOUCHER, SCHEME_LIEN]);
  } finally {
    await server.close();
  }
  const untyped = new VoucherMeter({ encumbra: chain, creditor: CREDITOR, domain: DOMAIN });
  await assert.rejects(() => serveMeteredResource({ encumbra: chain, price: 1n, asset: USDC, creditor: CREDITOR, handle: () => 1, meter: untyped }), /meter must be built with `token`/);
  await assert.rejects(() => serveMeteredResource({ encumbra: chain, price: 1n, asset: USDC, creditor: SOMEONE_ELSE, handle: () => 1 }), /must be the creditor/);
});

test("encumbra-voucher: hundreds of requests are served with no chain traffic and settle in one transaction", async () => {
  const { chain, ids, meter, serve, payer, PRICE } = await voucherServer();
  const server = await serve(() => ({ answer: 42 }));
  try {
    const id = ids[0];
    const readsAtStart = chain.reads;
    const p = payer(id);
    for (let i = 0; i < 200; i++) {
      const r = await p.get(`${server.url}/feed?q=${i}`);
      assert.equal(r.status, 200, `request ${i}: ${r.error}`);
      assert.deepEqual(r.data, { answer: 42 });
      assert.equal(r.settlement?.transaction, "");
    }
    assert.equal(p.runningTotal, PRICE * 200n);
    assert.equal(chain.sends, 0);
    assert.ok(chain.reads - readsAtStart <= 2, `only the one-time lien load reads, saw ${chain.reads - readsAtStart}`);
    assert.equal(meter.exposure(), PRICE * 200n);
    const report = await meter.settle();
    assert.equal(chain.sends, 1);
    assert.equal(report.settled, 1);
    assert.equal(report.amount, PRICE * 200n);
    assert.equal(chain.liens.get(id)!.settled, PRICE * 200n);
    assert.equal(meter.exposure(), 0n);
  } finally {
    await server.close();
  }
});

test("encumbra-voucher: an agent that lost its total is told where to resume; impostors and other creditors are refused", async () => {
  const { chain, ids, serve, payer, PRICE } = await voucherServer();
  const server = await serve();
  try {
    const id = ids[0];
    const none = await x402Fetch(`${server.url}/feed`);
    assert.match(none.required?.error ?? "", /PAYMENT-SIGNATURE header is required/);
    assert.equal(none.required?.accepts[0].extra.servedThrough, undefined);
    const first = payer(id);
    for (let i = 0; i < 3; i++) assert.equal((await first.get(`${server.url}/feed`)).status, 200);
    const restarted = payer(id);
    const r = await restarted.get(`${server.url}/feed`);
    assert.equal(r.status, 200, r.error);
    assert.equal(r.settlement?.extra?.cumulative, (4n * PRICE).toString());
    assert.equal(restarted.runningTotal, 4n * PRICE);

    const imp = await payer(id, stranger).get(`${server.url}/feed`);
    assert.equal(imp.settlement?.errorReason, ERRORS.voucherSignature);
    assert.equal(imp.required?.accepts[0].extra.servedThrough, undefined);

    const elsewhere = chain.open({ creditLimit: 50n * U, creditor: SOMEONE_ELSE });
    assert.equal((await payer(elsewhere).get(`${server.url}/feed`)).settlement?.errorReason, ERRORS.lienUnusable);
  } finally {
    await server.close();
  }
});

test("meter: local checks refuse bad vouchers without touching the chain", async () => {
  const { chain, ids, meter, sign, PRICE } = await voucherServer({ creditLimit: 50n * U });
  const id = ids[0];
  assert.deepEqual(await meter.accept(await sign(id, PRICE), PRICE), { ok: true, unsettled: PRICE, agent: agent.address.toLowerCase() });
  const reads = chain.reads;
  const refusals: Array<[string, Promise<SignedVoucher>, RegExp]> = [
    ["wrong signer", sign(id, 2n * PRICE, stranger), /signature does not match/],
    ["replay", sign(id, PRICE), /does not cover this request/],
    ["underpays", sign(id, PRICE + PRICE / 2n), /does not cover this request/],
    ["expires too soon", sign(id, 2n * PRICE, agent, chain.time + 60n), /expires too soon/],
    ["beyond the line", sign(id, 51n * U), /cannot cover/],
  ];
  for (const [label, voucher, why] of refusals) {
    const r = await meter.accept(await voucher, PRICE);
    assert.equal(r.ok, false, label);
    assert.match((r as { reason: string }).reason, why, label);
  }
  assert.equal(chain.reads, reads);
  assert.equal(meter.exposure(), PRICE);
});

test("meter: the unsettled cap, a freeze, batches and a chain that moved ahead", async () => {
  {
    const { ids, meter, sign, PRICE } = await voucherServer({ maxUnsettled: 5n * 10_000n });
    const id = ids[0];
    for (let i = 1n; i <= 5n; i++) assert.equal((await meter.accept(await sign(id, PRICE * i), PRICE)).ok, true);
    assert.match(((await meter.accept(await sign(id, 6n * PRICE), PRICE)) as { reason: string }).reason, /unsettled usage cap/);
    await meter.settle();
    assert.equal((await meter.accept(await sign(id, 6n * PRICE), PRICE)).ok, true);
  }
  {
    const { chain, ids, meter, sign, PRICE } = await voucherServer();
    const id = ids[0];
    for (let i = 1n; i <= 3n; i++) await meter.accept(await sign(id, PRICE * i), PRICE);
    chain.liens.get(id)!.frozen = true;
    const report = await meter.settle();
    assert.equal(report.rejected[0].reason, "frozen");
    assert.equal(meter.unsettled(id), 3n * PRICE);
    assert.match(((await meter.accept(await sign(id, 4n * PRICE), PRICE)) as { reason: string }).reason, /frozen/);
    chain.liens.get(id)!.frozen = false;
    meter.forget(id);
    assert.equal((await meter.accept(await sign(id, 4n * PRICE), PRICE)).ok, true);
    assert.equal((await meter.settle()).amount, 4n * PRICE);
  }
  {
    const { chain, ids, meter, sign, PRICE } = await voucherServer({ liens: 5, batchSize: 2 });
    for (const id of ids) assert.equal((await meter.accept(await sign(id, 7n * PRICE), 7n * PRICE)).ok, true);
    const report = await meter.settle();
    assert.equal(report.settled, 5);
    assert.equal(report.transactions, 3);
    assert.equal(chain.sends, 3);
  }
  {
    const { chain, ids, meter, sign, PRICE } = await voucherServer();
    const id = ids[0];
    const v = await sign(id, 10n * PRICE);
    assert.equal((await meter.accept(v, 10n * PRICE)).ok, true);
    await chain.settleVouchers([v]);
    const report = await meter.settle();
    assert.equal(report.rejected[0].reason, "stale voucher");
    assert.equal(meter.unsettled(id), 0n);
    assert.equal((await meter.accept(await sign(id, 11n * PRICE), PRICE)).ok, true);
  }
});
