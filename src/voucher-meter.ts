// Creditor-side voucher metering: what lets one service handle far more requests than the
// chain could ever record one by one.
//
// Per request the meter does NO chain work: it verifies the agent's signature locally, checks
// the voucher covers the price, and keeps only the latest voucher per lien. On a schedule
// (or when exposure crosses a threshold) `settle()` submits those latest vouchers in batches.
//
// The risk it manages is the window between serving a request and settling its voucher. If a
// lien is frozen, goes past due or fills up in that window, the voucher cannot settle and the
// usage already served is lost. The meter bounds that window three ways: it refuses a voucher
// the line cannot cover (`voucherRoom`), it can cap unsettled usage per lien (`maxUnsettled`),
// and it stops serving a lien the contract has rejected until the lien is reloaded.
import type { Address } from "viem";
import type { EncumbraClient } from "./client.ts";
import { recoverVoucherSigner, type SignedVoucher, type VoucherDomain } from "./voucher.ts";

/**
 * The chain access the meter needs. {@link EncumbraClient} provides it; its wallet must be the
 * creditor, because `settleVouchers` sends from it.
 */
export type MeterChain = Pick<EncumbraClient, "getLien" | "voucherRoom" | "settleVouchers" | "voucherSettled">;

export type MeterOptions = {
  encumbra: MeterChain;
  /** The address that submits settlements. Must be the creditor on every lien it serves. */
  creditor: Address;
  /**
   * The debt token this meter is paid in. A lien denominated in any other token is refused, so
   * an agent cannot pay for a service priced in one token with a line in another. Unset, the
   * meter accepts any token (the caller then checks it).
   */
  token?: Address;
  domain: VoucherDomain;
  /**
   * Refuse a voucher that expires sooner than this many seconds from now, so it is still valid
   * when the next settlement runs. Default 600. Set it above your settlement interval plus the
   * longest chain stall you want to ride out.
   */
  minValiditySecs?: number;
  /**
   * Most usage, in debt-token units, the creditor will serve on one lien before it is settled.
   * Past it, requests are refused until `settle()` runs. Default: no cap beyond the credit line.
   */
  maxUnsettled?: bigint;
  /** How long a lien's on-chain view is trusted before it is reloaded, in ms. Default 30000. */
  viewTtlMs?: number;
  /** Vouchers per settlement transaction. Default 40. */
  batchSize?: number;
  /** Clock in unix seconds. Defaults to wall time; pass chain time in tests. */
  now?: () => number;
  /** Wall-clock ms for the view TTL. Defaults to Date.now. */
  clockMs?: () => number;
};

/**
 * Why a voucher was refused, as a stable code (the `reason` text is for people):
 *   lien       the lien cannot be served at all (inactive, frozen, full, wrong creditor or token)
 *   signature  not signed by the lien's agent
 *   cumulative does not cover this request on top of what was already served
 *   expiry     expires before it could be settled
 *   room       the credit line cannot cover it
 *   cap        the creditor's unsettled-usage cap for this lien is reached
 */
export type RefusalCode = "lien" | "signature" | "cumulative" | "expiry" | "room" | "cap";

export type AcceptResult =
  | {
      ok: true;
      /** Usage served on this lien and not yet settled, including this request. */
      unsettled: bigint;
      /** The lien's agent, who signed the voucher (lowercase). */
      agent: Address;
    }
  | { ok: false; code: RefusalCode; reason: string };

export type SettleReport = {
  /** Liens whose latest voucher was applied on-chain. */
  settled: number;
  /** Usage, in debt-token units, those vouchers charged. */
  amount: bigint;
  rejected: Array<{ id: bigint; reason: string }>;
  transactions: number;
  gasUsed: bigint;
};

type LienState = {
  agent: Address;
  /** Cumulative the chain has settled. */
  settled: bigint;
  /** Cumulative of the latest voucher this meter accepted. Always >= settled. */
  accepted: bigint;
  voucher: SignedVoucher | null;
  /** Largest cumulative the line can still cover. */
  maxCumulative: bigint;
  /** Why this lien cannot be served right now, or null. */
  blocked: string | null;
  loadedAtMs: number;
};

export class VoucherMeter {
  private o: Required<Omit<MeterOptions, "encumbra" | "creditor" | "domain" | "maxUnsettled" | "token">> & {
    encumbra: MeterChain;
    creditor: Address;
    domain: VoucherDomain;
    maxUnsettled: bigint | null;
    token: Address | null;
  };
  private liens = new Map<string, LienState>();

  /** The debt token this meter is paid in, or null if it accepts any. */
  get token(): Address | null {
    return this.o.token;
  }

  constructor(opts: MeterOptions) {
    this.o = {
      encumbra: opts.encumbra,
      creditor: opts.creditor,
      domain: opts.domain,
      token: opts.token ?? null,
      minValiditySecs: opts.minValiditySecs ?? 600,
      maxUnsettled: opts.maxUnsettled ?? null,
      viewTtlMs: opts.viewTtlMs ?? 30_000,
      batchSize: opts.batchSize ?? 40,
      now: opts.now ?? (() => Math.floor(Date.now() / 1000)),
      clockMs: opts.clockMs ?? (() => Date.now()),
    };
  }

  /**
   * Check a voucher presented with one request priced at `price`. Verifies locally and, apart
   * from a reload once per `viewTtlMs` per lien, makes no chain call. On `ok` the caller serves
   * the request; the voucher is now the latest for its lien.
   */
  async accept(v: SignedVoucher, price: bigint): Promise<AcceptResult> {
    const key = v.id.toString();
    let st = this.liens.get(key);
    if (!st || this.o.clockMs() - st.loadedAtMs > this.o.viewTtlMs) {
      st = await this.load(v.id, st);
      this.liens.set(key, st);
    }
    if (st.blocked) return { ok: false, code: "lien", reason: st.blocked };

    const signer = await recoverVoucherSigner(this.o.domain, v);
    if (!signer || signer.toLowerCase() !== st.agent) {
      return { ok: false, code: "signature", reason: "voucher signature does not match the lien's agent" };
    }
    if (v.cumulative < st.accepted + price) return { ok: false, code: "cumulative", reason: "voucher does not cover this request" };
    if (v.deadline < BigInt(this.o.now() + this.o.minValiditySecs)) {
      return { ok: false, code: "expiry", reason: "voucher expires too soon to settle" };
    }
    if (v.cumulative > st.maxCumulative) return { ok: false, code: "room", reason: "credit line cannot cover this voucher" };
    const unsettled = v.cumulative - st.settled;
    if (this.o.maxUnsettled !== null && unsettled > this.o.maxUnsettled) {
      return { ok: false, code: "cap", reason: "unsettled usage cap reached, settlement pending" };
    }

    st.accepted = v.cumulative;
    st.voucher = v;
    return { ok: true, unsettled, agent: st.agent };
  }

  /**
   * The cumulative the meter has served through on this lien: where the agent's next voucher
   * must start from. An agent that restarts and lost its running total reads it from here.
   */
  async servedThrough(id: bigint): Promise<bigint> {
    const key = id.toString();
    let st = this.liens.get(key);
    if (!st) {
      st = await this.load(id);
      this.liens.set(key, st);
    }
    return st.accepted;
  }

  /** Usage served and not yet settled, summed over every lien. This is the creditor's live exposure. */
  exposure(): bigint {
    let total = 0n;
    for (const st of this.liens.values()) total += st.accepted - st.settled;
    return total;
  }

  /** Unsettled usage on one lien. */
  unsettled(id: bigint): bigint {
    const st = this.liens.get(id.toString());
    return st ? st.accepted - st.settled : 0n;
  }

  /**
   * Submit the latest voucher of every lien that has unsettled usage, in batches of
   * `batchSize`. A voucher the contract refuses blocks its lien until the lien is reloaded.
   */
  async settle(): Promise<SettleReport> {
    const report: SettleReport = { settled: 0, amount: 0n, rejected: [], transactions: 0, gasUsed: 0n };
    const pending = [...this.liens.values()].filter((st) => st.voucher && st.accepted > st.settled);

    for (let i = 0; i < pending.length; i += this.o.batchSize) {
      const chunk = pending.slice(i, i + this.o.batchSize);
      const res = await this.o.encumbra.settleVouchers(chunk.map((st) => st.voucher!));
      report.transactions++;
      report.gasUsed += res.gasUsed;

      for (const s of res.settled) {
        const st = this.liens.get(s.id.toString())!;
        st.settled = s.cumulative;
        report.settled++;
        report.amount += s.amount;
      }
      for (const r of res.rejected) {
        const st = this.liens.get(r.id.toString())!;
        report.rejected.push({ id: r.id, reason: r.reason });
        if (r.reason === "stale voucher") {
          // The chain is ahead of us (settled by another path). Resync rather than block.
          st.settled = await this.o.encumbra.voucherSettled(r.id);
          if (st.accepted < st.settled) st.accepted = st.settled;
        } else {
          st.blocked = `lien cannot be served: ${r.reason}`;
        }
      }
    }
    return report;
  }

  /** Drop what is cached for a lien so the next request reloads it (e.g. after an owner unfreezes). */
  forget(id: bigint): void {
    const st = this.liens.get(id.toString());
    if (st) st.loadedAtMs = Number.NEGATIVE_INFINITY;
  }

  private async load(id: bigint, prev?: LienState): Promise<LienState> {
    const [lien, room] = await Promise.all([this.o.encumbra.getLien(id), this.o.encumbra.voucherRoom(id)]);
    let blocked: string | null = null;
    if (lien.status !== "Active") blocked = `lien is ${lien.status.toLowerCase()}`;
    else if (lien.creditor.toLowerCase() !== this.o.creditor.toLowerCase()) blocked = "lien is owed to a different creditor";
    else if (this.o.token && lien.debtToken.toLowerCase() !== this.o.token.toLowerCase()) blocked = "lien is in a different token";
    else if (lien.frozen) blocked = "lien is frozen";
    else if (room.maxCumulative <= room.settled) blocked = "lien has no room (full or past due)";

    // Usage already served under an earlier view stays owed; keep the higher of the two cursors.
    const accepted = prev && prev.accepted > room.settled ? prev.accepted : room.settled;
    return {
      agent: lien.agent.toLowerCase() as Address,
      settled: room.settled,
      accepted,
      voucher: prev?.voucher ?? null,
      maxCumulative: room.maxCumulative,
      blocked,
      loadedAtMs: this.o.clockMs(),
    };
  }
}
