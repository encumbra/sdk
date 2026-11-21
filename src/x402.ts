// HTTP x402 (protocol version 2), paid from an Encumbra lien.
//
// x402 revives HTTP 402 Payment Required for machine payments. Version 2 carries everything
// in three headers, each a base64-encoded JSON object:
//
//   PAYMENT-REQUIRED   server -> client, on a 402: what the resource accepts (`accepts[]`)
//   PAYMENT-SIGNATURE  client -> server, on the retry: the chosen requirement plus the payment
//   PAYMENT-RESPONSE   server -> client: the settlement result (on the 200, and on a failed 402)
//
// Networks are CAIP-2 ids (`eip155:84532` for Base Sepolia), read from the contract's own
// chain id. Encumbra offers two schemes in `accepts`, both drawn on a credit line instead of
// a prepaid balance:
//
//   encumbra-voucher  the agent signs a CUMULATIVE voucher per request. The server verifies it
//                     locally and serves with no chain call; a VoucherMeter settles the latest
//                     voucher per lien later, one transaction for any number of requests.
//   encumbra-lien     the agent signs one `Charge` per request; the server submits it with
//                     `chargeWithAuth` before serving. One transaction per request, and the
//                     lien's sequential charge nonce makes it one request at a time per lien.
//
// In both, the payment is the agent's EIP-712 signature: the server only draws on a lien whose
// agent signed for it, in the token it prices in, owed to itself. When a payment is refused
// for a reason the agent can fix (a stale nonce, a running total behind what was served), the
// 402 names the payer's lien in `extra.lienId` and carries the corrected `extra.chargeNonce` or
// `extra.servedThrough`, so the client re-signs once without reading the chain.
//
// The server needs Node's `node:http`, loaded on first use, so importing this module (and the
// SDK) stays safe in runtimes without it; the client half runs anywhere `fetch` does.
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { recoverTypedDataAddress, zeroHash, type Address, type Hex } from "viem";
import { CHARGE_TYPES } from "./charge.ts";
import type { EncumbraClient } from "./client.ts";
import type { RefusalCode, VoucherMeter } from "./voucher-meter.ts";
import { signVoucher, splitVoucherSignature, voucherSignature, type SignedVoucher, type TypedDataSigner } from "./voucher.ts";

export const X402_VERSION = 2;
export const HEADER_REQUIRED = "PAYMENT-REQUIRED";
export const HEADER_SIGNATURE = "PAYMENT-SIGNATURE";
export const HEADER_RESPONSE = "PAYMENT-RESPONSE";
export const SCHEME_VOUCHER = "encumbra-voucher";
export const SCHEME_LIEN = "encumbra-lien";
export type EncumbraScheme = typeof SCHEME_VOUCHER | typeof SCHEME_LIEN;

/**
 * Settlement error codes. The generic ones are x402's own; the rest are scheme-specific.
 * Clients branch on these, never on message text.
 */
export const ERRORS = {
  invalidPayload: "invalid_payload",
  invalidVersion: "invalid_x402_version",
  unsupportedScheme: "unsupported_scheme",
  invalidRequirements: "invalid_payment_requirements",
  insufficientFunds: "insufficient_funds",
  settleFailed: "unexpected_settle_error",
  lienUnusable: "invalid_encumbra_lien",
  lienSignature: "invalid_encumbra_lien_signature",
  lienNonce: "invalid_encumbra_lien_nonce",
  lienDeadline: "invalid_encumbra_lien_deadline",
  voucherSignature: "invalid_encumbra_voucher_signature",
  voucherCumulative: "invalid_encumbra_voucher_cumulative",
  voucherDeadline: "invalid_encumbra_voucher_deadline",
} as const;

export type ResourceInfo = { url: string; description?: string; mimeType?: string };

export type PaymentRequirements = {
  scheme: string;
  /** CAIP-2 network id, e.g. `eip155:84532`. */
  network: string;
  /** Price of one request, in atomic units of `asset`. */
  amount: string;
  /** The debt token the lien must be denominated in. */
  asset: string;
  /** The creditor: the lien must be owed to this address. */
  payTo: string;
  maxTimeoutSeconds: number;
  extra: {
    /** EIP-712 domain the agent signs under; the chain id comes from `network`. */
    name: string;
    version: string;
    verifyingContract: string;
    /** On a corrective 402: the payer's lien that the fields below are about. */
    lienId?: string;
    /** encumbra-lien, corrective: the nonce the next Charge must carry. */
    chargeNonce?: string;
    /** encumbra-voucher, corrective: the cumulative already served; the next voucher adds the price to it. */
    servedThrough?: string;
  };
};

export type PaymentRequired = {
  x402Version: number;
  error?: string;
  resource: ResourceInfo;
  accepts: PaymentRequirements[];
};

/** encumbra-lien: the agent's EIP-712 `Charge` for `accepted.amount` on its lien. */
export type LienPayload = { lienId: string; nonce: string; deadline: string; signature: string };
/** encumbra-voucher: the agent's EIP-712 `Voucher` carrying its new running total. */
export type VoucherPayload = { lienId: string; cumulative: string; deadline: string; ref: string; signature: string };

export type PaymentPayload = {
  x402Version: number;
  resource?: ResourceInfo;
  accepted: PaymentRequirements;
  payload: LienPayload | VoucherPayload;
};

export type SettlementResponse = {
  success: boolean;
  errorReason?: string;
  errorMessage?: string;
  payer?: string;
  /** The settlement transaction, or "" when nothing was broadcast (a voucher settles later). */
  transaction: string;
  network: string;
  amount?: string;
  extra?: Record<string, string>;
};

/** base64(JSON), the encoding of all three x402 headers. bigints are written as decimal strings. */
export function encodeHeader(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Decode an x402 header. Accepts the standard and the URL-safe base64 alphabets. Throws if malformed. */
export function decodeHeader<T>(raw: string): T {
  const std = raw.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  const bin = atob(std + "=".repeat((4 - (std.length % 4)) % 4));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)) as T;
}

/** `eip155:<id>` -> id. Throws for any other namespace. */
export function chainIdOf(network: string): bigint {
  const m = /^eip155:(\d+)$/.exec(network);
  if (!m) throw new Error(`not an EVM CAIP-2 network: ${network}`);
  return BigInt(m[1]);
}

function domainOf(req: PaymentRequirements) {
  return { name: req.extra.name, version: req.extra.version, chainId: chainIdOf(req.network), verifyingContract: req.extra.verifyingContract as Address };
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// ---------------------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------------------

export type X402Server = { url: string; port: number; close: () => Promise<void> };

/**
 * The chain access the server needs. {@link EncumbraClient} provides it; for `encumbra-lien`
 * its wallet must be the creditor, because each charge is submitted from it.
 */
export type ResourceChain = Pick<
  EncumbraClient,
  "domain" | "getLien" | "chargeNonce" | "isServiceable" | "available" | "now" | "submitChargeAuth" | "execAccount"
>;

export type ServeOptions = {
  encumbra: ResourceChain;
  /** Price of one request, in atomic units of `asset`. */
  price: bigint;
  /** The debt token requests are priced in; a lien in another token is refused. */
  asset: Address;
  /** The creditor address: it submits settlements, and only liens owed to it can pay. */
  creditor: Address;
  handle: (query: URLSearchParams) => unknown;
  /**
   * Offer `encumbra-voucher`, settled later through this meter. The meter must be built for
   * the same creditor and `asset`. Without a meter only `encumbra-lien` is offered.
   */
  meter?: VoucherMeter;
  /** Also offer `encumbra-lien` (a transaction per request) when a meter is set. Default true. */
  offerLien?: boolean;
  description?: string;
  /** How long a payment signature must stay valid for the server to use it. Default 60. */
  maxTimeoutSeconds?: number;
  /** Interface to listen on. Default 127.0.0.1. */
  host?: string;
  /** Port to listen on. Default 0 (an ephemeral port). */
  port?: number;
};

type Reply = { status: number; headers: Record<string, string>; body: unknown };

/**
 * Start a metered HTTP resource paid from Encumbra liens over x402 v2. Every path is the
 * resource; by default it listens on an ephemeral port on 127.0.0.1.
 */
export async function serveMeteredResource(opts: ServeOptions): Promise<X402Server> {
  if (opts.meter && !(opts.meter.token && same(opts.meter.token, opts.asset))) {
    throw new Error("serveMeteredResource: the meter must be built with `token` set to the resource's asset");
  }
  const offersLien = !opts.meter || opts.offerLien !== false;
  if (offersLien && opts.encumbra.execAccount && !same(opts.encumbra.execAccount, opts.creditor)) {
    throw new Error("serveMeteredResource: encumbra-lien charges are submitted from the client's wallet, which must be the creditor");
  }
  const domain = await opts.encumbra.domain();
  const network = `eip155:${domain.chainId}`;
  const base = {
    network,
    amount: opts.price.toString(),
    asset: opts.asset,
    payTo: opts.creditor,
    maxTimeoutSeconds: opts.maxTimeoutSeconds ?? 60,
    extra: { name: domain.name, version: domain.version, verifyingContract: domain.verifyingContract },
  };
  const offers: PaymentRequirements[] = [];
  if (opts.meter) offers.push({ scheme: SCHEME_VOUCHER, ...base, extra: { ...base.extra } });
  if (offersLien) offers.push({ scheme: SCHEME_LIEN, ...base, extra: { ...base.extra } });

  const failure = (errorReason: string, errorMessage: string, payer?: string): SettlementResponse => ({
    success: false,
    errorReason,
    errorMessage,
    payer,
    transaction: "",
    network,
  });

  /** A 402: what is accepted (optionally corrected for one lien) and, after a payment attempt, why it failed. */
  const paymentRequired = (resource: ResourceInfo, error: string, settlement?: SettlementResponse, corrected?: PaymentRequirements): Reply => {
    const accepts = corrected ? offers.map((o) => (o.scheme === corrected.scheme ? corrected : o)) : offers;
    const required: PaymentRequired = { x402Version: X402_VERSION, error, resource, accepts };
    const headers: Record<string, string> = { [HEADER_REQUIRED]: encodeHeader(required), "cache-control": "no-store" };
    if (settlement) headers[HEADER_RESPONSE] = encodeHeader(settlement);
    return { status: 402, headers, body: { error } };
  };

  const served = (query: URLSearchParams, settlement: SettlementResponse): Reply => ({
    status: 200,
    headers: { [HEADER_RESPONSE]: encodeHeader(settlement) },
    body: { data: opts.handle(query) },
  });

  async function payWithVoucher(resource: ResourceInfo, query: URLSearchParams, req: PaymentRequirements, p: VoucherPayload): Promise<Reply> {
    const id = BigInt(p.lienId);
    const sig = splitVoucherSignature(p.signature as Hex);
    const voucher: SignedVoucher = { id, cumulative: BigInt(p.cumulative), deadline: BigInt(p.deadline), ref: p.ref as Hex, r: sig.r, s: sig.s, v: sig.v };
    const verdict = await opts.meter!.accept(voucher, opts.price);
    if (!verdict.ok) {
      // Only a running total that is behind is something the agent can fix by re-signing, and
      // only then has its signature already been checked, so only then is the total disclosed.
      const corrected =
        verdict.code === "cumulative"
          ? { ...req, extra: { ...req.extra, lienId: id.toString(), servedThrough: (await opts.meter!.servedThrough(id)).toString() } }
          : undefined;
      return paymentRequired(resource, verdict.reason, failure(voucherCode(verdict.code), verdict.reason), corrected);
    }
    return served(query, {
      success: true,
      payer: verdict.agent,
      transaction: "",
      network,
      amount: opts.price.toString(),
      extra: { lienId: id.toString(), cumulative: voucher.cumulative.toString(), unsettled: verdict.unsettled.toString() },
    });
  }

  async function payWithLien(resource: ResourceInfo, query: URLSearchParams, req: PaymentRequirements, p: LienPayload): Promise<Reply> {
    const id = BigInt(p.lienId);
    const lien = await opts.encumbra.getLien(id);
    if (lien.status !== "Active" || !same(lien.creditor, opts.creditor) || !same(lien.debtToken, opts.asset)) {
      const why = lien.status !== "Active" ? `lien is ${lien.status.toLowerCase()}` : !same(lien.creditor, opts.creditor) ? "lien is owed to a different creditor" : "lien is in a different token";
      return paymentRequired(resource, why, failure(ERRORS.lienUnusable, why));
    }
    const auth = { id, amount: opts.price, nonce: BigInt(p.nonce), deadline: BigInt(p.deadline), signature: p.signature as Hex };
    let signer: string | null = null;
    try {
      signer = await recoverTypedDataAddress({
        domain: domainOf(req),
        types: CHARGE_TYPES,
        primaryType: "Charge",
        message: { lienId: id, amount: auth.amount, nonce: auth.nonce, deadline: auth.deadline },
        signature: auth.signature,
      });
    } catch {
      signer = null;
    }
    if (!signer || !same(signer, lien.agent)) {
      return paymentRequired(resource, "charge not signed by the lien's agent", failure(ERRORS.lienSignature, "charge not signed by the lien's agent"));
    }
    const nonce = await opts.encumbra.chargeNonce(id);
    if (auth.nonce !== nonce) {
      const corrected = { ...req, extra: { ...req.extra, lienId: id.toString(), chargeNonce: nonce.toString() } };
      return paymentRequired(resource, "stale charge nonce", failure(ERRORS.lienNonce, `expected nonce ${nonce}`, lien.agent), corrected);
    }
    if (auth.deadline < (await opts.encumbra.now())) {
      return paymentRequired(resource, "charge authorization expired", failure(ERRORS.lienDeadline, "charge authorization expired", lien.agent));
    }
    if (!(await opts.encumbra.isServiceable(id)) || (await opts.encumbra.available(id)) < opts.price) {
      return paymentRequired(resource, "credit line cannot cover this request", failure(ERRORS.insufficientFunds, "settle (repay) the lien, then retry", lien.agent));
    }
    // Settle before serving: the resource is only produced once the draw is on-chain.
    let tx;
    try {
      tx = await opts.encumbra.submitChargeAuth(auth);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const code = /over limit|past due|frozen/.test(msg) ? ERRORS.insufficientFunds : ERRORS.settleFailed;
      return paymentRequired(resource, "settlement failed", failure(code, msg.slice(0, 160), lien.agent));
    }
    return served(query, { success: true, payer: lien.agent, transaction: tx.hash ?? "", network, amount: opts.price.toString(), extra: { lienId: id.toString() } });
  }

  async function respond(url: URL, header: string | undefined): Promise<Reply> {
    const resource: ResourceInfo = { url: url.toString(), description: opts.description, mimeType: "application/json" };
    if (!header) return paymentRequired(resource, `${HEADER_SIGNATURE} header is required`);

    let payment: PaymentPayload;
    try {
      payment = decodeHeader<PaymentPayload>(header);
      if (!payment || typeof payment !== "object" || !payment.accepted || !payment.payload) throw new Error("incomplete");
    } catch {
      return { status: 400, headers: { [HEADER_RESPONSE]: encodeHeader(failure(ERRORS.invalidPayload, "malformed payment header")) }, body: { error: "malformed payment header" } };
    }
    if (payment.x402Version !== X402_VERSION) {
      return paymentRequired(resource, "unsupported x402 version", failure(ERRORS.invalidVersion, `expected x402Version ${X402_VERSION}`));
    }
    const a = payment.accepted;
    const offer = offers.find((o) => o.scheme === a.scheme);
    if (!offer) return paymentRequired(resource, "unsupported scheme", failure(ERRORS.unsupportedScheme, `scheme ${a.scheme} is not offered`));
    if (a.network !== offer.network || a.amount !== offer.amount || !same(a.asset, offer.asset) || !same(a.payTo, offer.payTo) || !same(a.extra?.verifyingContract ?? "", offer.extra.verifyingContract)) {
      return paymentRequired(resource, "payment requirements do not match", failure(ERRORS.invalidRequirements, "accepted does not match what this resource offers"));
    }
    try {
      return a.scheme === SCHEME_VOUCHER
        ? await payWithVoucher(resource, url.searchParams, offer, payment.payload as VoucherPayload)
        : await payWithLien(resource, url.searchParams, offer, payment.payload as LienPayload);
    } catch {
      return { status: 400, headers: { [HEADER_RESPONSE]: encodeHeader(failure(ERRORS.invalidPayload, "malformed payment payload")) }, body: { error: "malformed payment payload" } };
    }
  }

  const { createServer } = await import("node:http");
  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const raw = req.headers[HEADER_SIGNATURE.toLowerCase()];
      const r = await respond(url, Array.isArray(raw) ? raw[0] : raw);
      res.writeHead(r.status, {
        "content-type": "application/json",
        "access-control-expose-headers": `${HEADER_REQUIRED}, ${HEADER_RESPONSE}`,
        ...r.headers,
      });
      res.end(JSON.stringify(r.body));
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(err instanceof Error ? err.message : err) }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const host = opts.host ?? "127.0.0.1";
  return {
    url: `http://${host.includes(":") ? `[${host}]` : host}:${port}`,
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function voucherCode(code: RefusalCode): string {
  switch (code) {
    case "signature":
      return ERRORS.voucherSignature;
    case "cumulative":
      return ERRORS.voucherCumulative;
    case "expiry":
      return ERRORS.voucherDeadline;
    case "lien":
      return ERRORS.lienUnusable;
    case "room":
    case "cap":
      return ERRORS.insufficientFunds;
  }
}

// ---------------------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------------------

export type X402Response = {
  status: number;
  data?: unknown;
  /** Decoded PAYMENT-REQUIRED, on a 402. */
  required?: PaymentRequired;
  /** Decoded PAYMENT-RESPONSE, when the server sent one. */
  settlement?: SettlementResponse;
  /** The server's error text, if any. */
  error?: string;
};

/** One HTTP GET, optionally carrying a payment. Decodes the x402 headers of the answer. */
export async function x402Fetch(url: string, payment?: PaymentPayload): Promise<X402Response> {
  const r = await fetch(url, { headers: payment ? { [HEADER_SIGNATURE]: encodeHeader(payment) } : {} });
  const body = (await r.json().catch(() => ({}))) as { data?: unknown; error?: string };
  const req = r.headers.get(HEADER_REQUIRED);
  const resp = r.headers.get(HEADER_RESPONSE);
  return {
    status: r.status,
    data: body?.data,
    error: body?.error,
    required: req ? decodeHeader<PaymentRequired>(req) : undefined,
    settlement: resp ? decodeHeader<SettlementResponse>(resp) : undefined,
  };
}

/** Agent side: the payload for `encumbra-lien`, a signed Charge of `req.amount`. */
export async function signLienPayment(
  req: PaymentRequirements,
  p: { lienId: bigint; nonce: bigint; deadline: bigint; signer: TypedDataSigner; resource?: ResourceInfo },
): Promise<PaymentPayload> {
  const signature = await p.signer.signTypedData({
    domain: domainOf(req),
    types: CHARGE_TYPES,
    primaryType: "Charge",
    message: { lienId: p.lienId, amount: BigInt(req.amount), nonce: p.nonce, deadline: p.deadline },
  });
  return {
    x402Version: X402_VERSION,
    resource: p.resource,
    accepted: stripCorrections(req),
    payload: { lienId: p.lienId.toString(), nonce: p.nonce.toString(), deadline: p.deadline.toString(), signature },
  };
}

/** Agent side: the payload for `encumbra-voucher`, a voucher raising the running total to `cumulative`. */
export async function signVoucherPayment(
  req: PaymentRequirements,
  p: { lienId: bigint; cumulative: bigint; deadline: bigint; signer: TypedDataSigner; ref?: Hex; resource?: ResourceInfo },
): Promise<PaymentPayload> {
  const v = await signVoucher(p.signer, { chainId: chainIdOf(req.network), verifyingContract: req.extra.verifyingContract as Address }, {
    id: p.lienId,
    cumulative: p.cumulative,
    deadline: p.deadline,
    ref: p.ref ?? zeroHash,
  });
  return {
    x402Version: X402_VERSION,
    resource: p.resource,
    accepted: stripCorrections(req),
    payload: {
      lienId: p.lienId.toString(),
      cumulative: v.cumulative.toString(),
      deadline: v.deadline.toString(),
      ref: v.ref,
      signature: voucherSignature(v),
    },
  };
}

/** The offer as the server advertises it to everyone, without one payer's corrections. */
function stripCorrections(req: PaymentRequirements): PaymentRequirements {
  const { lienId: _l, chargeNonce: _c, servedThrough: _s, ...extra } = req.extra;
  return { ...req, extra };
}

export type LienPayerOptions = {
  /** The agent's lien that pays. */
  lienId: bigint;
  /** The lien's agent. */
  signer: TypedDataSigner;
  /** Scheme to pay with when the server offers both. Default: voucher, the cheaper one. */
  prefer?: EncumbraScheme;
  /** Unix seconds; deadlines are counted from it. Defaults to wall time. */
  now?: () => bigint | number | Promise<bigint | number>;
  /** Validity of a voucher. Default 86400 (the creditor settles later). */
  voucherTtlSecs?: bigint;
};

/**
 * An agent's x402 client for one lien. It remembers the requirements a URL answered with, so
 * after the first 402 every request carries its payment up front, and it keeps the running
 * voucher total and the next charge nonce itself. When the server corrects either in a 402, it
 * adopts the correction and re-signs once.
 */
export class LienPayer {
  private readonly o: LienPayerOptions;
  private readonly known = new Map<string, PaymentRequired>();
  private cumulative = 0n;
  private nonce: bigint | null = null;

  constructor(opts: LienPayerOptions) {
    this.o = opts;
  }

  /** The voucher total this payer has signed so far. */
  get runningTotal(): bigint {
    return this.cumulative;
  }

  async get(url: string): Promise<X402Response> {
    const key = url.split("?")[0];
    let required = this.known.get(key);
    if (!required) {
      const first = await x402Fetch(url);
      if (first.status !== 402 || !first.required) return first;
      required = first.required;
      this.known.set(key, required);
    }
    let req = this.choose(required);
    if (!req) return { status: 402, required, error: "no Encumbra scheme offered" };

    for (let attempt = 0; ; attempt++) {
      const res = await x402Fetch(url, await this.pay(req, required.resource));
      if (res.status === 200) {
        if (req.scheme === SCHEME_LIEN) this.nonce = (this.nonce ?? 0n) + 1n;
        return res;
      }
      const corrected = res.required?.accepts.find((a) => a.scheme === req!.scheme && a.extra.lienId === this.o.lienId.toString());
      if (res.status !== 402 || attempt > 0 || !corrected || !this.adopt(corrected)) {
        if (req.scheme === SCHEME_VOUCHER) this.cumulative -= BigInt(req.amount); // nothing was served for it
        return res;
      }
      if (req.scheme === SCHEME_VOUCHER) this.cumulative -= BigInt(req.amount);
      req = corrected;
    }
  }

  private choose(required: PaymentRequired): PaymentRequirements | undefined {
    const ours = required.accepts.filter((a) => a.scheme === SCHEME_VOUCHER || a.scheme === SCHEME_LIEN);
    return ours.find((a) => a.scheme === (this.o.prefer ?? SCHEME_VOUCHER)) ?? ours[0];
  }

  /** Take a server correction for this lien. False if it corrects nothing this payer tracks. */
  private adopt(c: PaymentRequirements): boolean {
    if (c.scheme === SCHEME_LIEN && c.extra.chargeNonce !== undefined) {
      this.nonce = BigInt(c.extra.chargeNonce);
      return true;
    }
    if (c.scheme === SCHEME_VOUCHER && c.extra.servedThrough !== undefined && BigInt(c.extra.servedThrough) !== this.cumulative - BigInt(c.amount)) {
      this.cumulative = BigInt(c.extra.servedThrough) + BigInt(c.amount);
      return true;
    }
    return false;
  }

  private async pay(req: PaymentRequirements, resource: ResourceInfo): Promise<PaymentPayload> {
    const now = BigInt(await (this.o.now ?? (() => Math.floor(Date.now() / 1000)))());
    if (req.scheme === SCHEME_VOUCHER) {
      this.cumulative += BigInt(req.amount);
      return signVoucherPayment(req, {
        lienId: this.o.lienId,
        cumulative: this.cumulative,
        deadline: now + (this.o.voucherTtlSecs ?? 86_400n),
        signer: this.o.signer,
        resource,
      });
    }
    return signLienPayment(req, {
      lienId: this.o.lienId,
      nonce: this.nonce ?? 0n,
      deadline: now + BigInt(req.maxTimeoutSeconds),
      signer: this.o.signer,
      resource,
    });
  }
}
