# @encumbra/sdk

TypeScript client for the [Encumbra](https://encumbra.ai) lien protocol on EVM-compatible chains, built on [viem](https://viem.sh).

Encumbra puts a self-enforcing lien on collateral: an owner opens a credit line for an agent, the agent draws on it with its own signature, and every outcome is written to the agent's on-chain record. This package lets agents, creditors and apps:

- read lien, governance and KeeperBond state (`getLien`, `available`, `isServiceable`, `healthFactor`, `agentStats`, ...);
- prepare unsigned calls (`prepare*`) for a wallet or policy engine to review and sign;
- build the EIP-712 typed data an agent signs: consent to be named on a lien, a draw authorization, an installment schedule, a usage voucher;
- pay for HTTP resources over [x402](https://www.x402.org) from a credit line, and serve resources that accept such payments.

Signing stays in your wallet layer. Nothing in the default surface moves funds on its own.

**Status:** pre-launch. The first deployment is Base Sepolia (chain id 84532). Contract addresses are listed on the Networks page of the [documentation](https://encumbra.ai/docs) once they are published; until then `NETWORKS[84532].address` is empty and you pass the address yourself.

## Install

```sh
npm i @encumbra/sdk viem
```

The package is ESM-only and ships its own type declarations. It runs in Node.js 20+, browsers, and edge runtimes such as Cloudflare Workers; only `serveMeteredResource` needs Node.js (it loads `node:http` when called).

## Quick start

Create an `EncumbraClient` around a viem `PublicClient`, read a lien, and prepare an unsigned call:

```ts
import { createPublicClient, http, type Address } from "viem";
import { DEFAULT_CHAIN_ID, EncumbraClient, formatHealthFactor, formatUnits, networkFor } from "@encumbra/sdk";

const net = networkFor(DEFAULT_CHAIN_ID); // Base Sepolia (84532)
const LIEN_REGISTRY: Address = "0x0000000000000000000000000000000000000000"; // EncumbraLien, from the Networks page

const publicClient = createPublicClient({ chain: net.chain, transport: http(net.defaultRpcUrl) });
const encumbra = new EncumbraClient({ publicClient, address: LIEN_REGISTRY, chainId: net.chainId });

// Read a lien.
const lien = await encumbra.getLien(1n);
console.log(lien.status, lien.agent, formatUnits(lien.debt, 6));
console.log("available:", formatUnits(await encumbra.available(1n), 6));
console.log("serviceable:", await encumbra.isServiceable(1n));
console.log("health:", formatHealthFactor(await encumbra.healthFactor(1n)));
console.log("agent record:", await encumbra.agentStats(lien.agent));

// Prepare an unsigned call. Nothing is signed or sent.
const repay = encumbra.prepareRepay(1n, 5_000_000n); // 5 USDC
console.log(repay.summary, repay.role); // what signing does, and who should sign
// repay.to, repay.data and repay.value ("0x0") go to the wallet or policy engine.
```

> `networkFor(chainId).chain` is typed as a generic viem `Chain`, which is what `EncumbraClient` expects. If you build the client with a chain-specific object such as `baseSepolia` from `viem/chains`, cast it: `createPublicClient({ ... }) as PublicClient`.

A `PreparedCall` carries `chainId`, `to`, `data`, `value` (always `"0x0"`), the `functionName`, decoded `args`, a one-line `summary` and the `role` expected to sign it. Every `EncumbraClient.prepare*` method is also exported as a standalone function that takes `{ chainId, address }`, so calls can be built without an RPC connection:

```ts
import { createWalletClient, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { decodeEncumbraCalldata, networkFor, prepareRepay } from "@encumbra/sdk";

const net = networkFor(84532); // Base Sepolia
const LIEN_REGISTRY: Address = "0x0000000000000000000000000000000000000000";
const account = privateKeyToAccount(process.env.OWNER_KEY as `0x${string}`);
const wallet = createWalletClient({ account, chain: net.chain, transport: http(net.defaultRpcUrl) });

// The same calls exist as standalone functions taking { chainId, address }.
const call = prepareRepay({ chainId: net.chainId, address: LIEN_REGISTRY }, 1n, 5_000_000n);

// Check what you are about to sign, then send it from your own wallet.
console.log(decodeEncumbraCalldata(call.data)); // { functionName: "repay", args: { id: "1", amount: "5000000" }, summary: "repay(id=1, amount=5000000)" }
console.log(call.summary); // includes any ERC-20 approval the call needs first
const hash = await wallet.sendTransaction({ to: call.to, data: call.data });
console.log(hash);
```

## Agent consent at open

An address can only be named agent on a lien with its agreement: either the agent opens the lien itself, or it signs an `OpenConsent` and the owner submits it with `openWithConsent`. Every open and every consent carries `termsHash`, the EIP-712 hash of the governance terms in force (usage, protocol and keeper fees, past-due grace, oracle, keeper module). If governance changes the terms before the owner submits, the open reverts with `terms mismatch` instead of opening on terms the agent never saw.

```ts
import { createPublicClient, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { BASE_SEPOLIA_USDC, EncumbraClient, computeTermsHash, networkFor, type OpenParams } from "@encumbra/sdk";

const net = networkFor(84532); // Base Sepolia
const LIEN_REGISTRY: Address = "0x0000000000000000000000000000000000000000";
const publicClient = createPublicClient({ chain: net.chain, transport: http(net.defaultRpcUrl) });
const encumbra = new EncumbraClient({ publicClient, address: LIEN_REGISTRY, chainId: net.chainId });

const agent = privateKeyToAccount(process.env.AGENT_KEY as `0x${string}`);
const owner: Address = "0x00000000000000000000000000000000000000b1";
const creditor: Address = "0x00000000000000000000000000000000000000c1";

const params: OpenParams = {
  agent: agent.address,
  creditor,
  token: BASE_SEPOLIA_USDC, // debt token; collateralToken defaults to it (same-token lien)
  collateral: 100_000_000n, // 100 USDC
  creditLimit: 50_000_000n, // 50 USDC
};

// 1. Read the governance terms this lien would open on, and their hash.
//    Reverts while intake is paused or when creditLimit is under the token's minimum.
const { terms, termsHash } = await encumbra.termsForOpen(false, params.token, params.creditLimit);
console.log(terms); // usageFeeBps, protocolFeeBps, keeperRewardBps, graceSecs, oracle, keeperModule
if (computeTermsHash(terms) !== termsHash) throw new Error("terms hash mismatch");

// 2. The agent signs its consent to exactly these params and terms.
const typedData = await encumbra.buildOpenConsent({ ...params, termsHash }, owner);
const signature = await agent.signTypedData(typedData);

// 3. The owner submits the open with the agent's signature, nonce and deadline.
const open = encumbra.prepareOpenWithConsent(
  { ...params, termsHash },
  { nonce: typedData.message.nonce, deadline: typedData.message.deadline, signature },
);
console.log(open.summary);
```

Related helpers:

| | |
|---|---|
| `encumbra.termsForOpen(oraclePriced, debtToken, creditLimit)` | Terms and hash exactly as the open will check them (also enforces the token's minimum credit limit). |
| `encumbra.openTerms(oraclePriced)` / `currentTermsHash(oraclePriced)` | The current terms for a lien shape; `oraclePriced` is `true` when collateral and debt tokens differ. |
| `computeTermsHash(terms)` | The hash computed locally, to check what governance reports or what a counterparty sent. |
| `termsOfLien(lien)` / `encumbra.lienTermsHash(id)` | The terms an existing lien captured at open. |
| `buildOpenConsentTypedData(ctx, params)` | The same typed data as `buildOpenConsent`, built offline from `{ chainId, verifyingContract, owner, nonce, deadline }`. |
| `encumbra.buildOpenAssetConsent` / `prepareOpenAssetWithConsent` | The same flow for a lien backed by an ERC-721 title. |
| `encumbra.prepareCancelConsents(nonces)` | Revoke consents the agent handed out but no longer wants. |

Consent nonces are unordered, so an agent can hand out several consents at once. The default validity is one hour (`opts.ttlSeconds` changes it).

## x402: paying from a credit line

Encumbra offers two x402 v2 schemes, both drawn on a lien instead of a prepaid balance:

- `encumbra-voucher`: the agent signs a cumulative voucher per request. The server verifies it locally and serves with no chain call; the creditor settles the latest voucher per lien later, in one transaction for any number of requests.
- `encumbra-lien`: the agent signs one EIP-712 `Charge` per request, which the server submits with `chargeWithAuth` before serving.

`LienPayer` is the agent side. It remembers what each URL accepts, keeps the running voucher total and the next charge nonce, and re-signs once when the server sends a correction:

```ts
import { privateKeyToAccount } from "viem/accounts";
import { LienPayer, SCHEME_LIEN, x402Fetch } from "@encumbra/sdk";

const agent = privateKeyToAccount(process.env.AGENT_KEY as `0x${string}`);

// See what a resource accepts, without paying.
const probe = await x402Fetch("https://api.example.com/quote?symbol=ETH");
if (probe.status === 402) console.log(probe.required?.accepts);

// Pay from lien #7. Vouchers are preferred when offered; SCHEME_LIEN pays one Charge per request.
const payer = new LienPayer({ lienId: 7n, signer: agent });
const res = await payer.get("https://api.example.com/quote?symbol=ETH");
if (res.status === 200) {
  console.log(res.data, res.settlement);
} else {
  console.log(res.status, res.settlement?.errorReason ?? res.error);
}
console.log("signed so far:", payer.runningTotal);

const perRequest = new LienPayer({ lienId: 7n, signer: agent, prefer: SCHEME_LIEN });
console.log((await perRequest.get("https://api.example.com/quote?symbol=BTC")).status);
```

`x402Fetch` performs a single GET and decodes the `PAYMENT-REQUIRED` and `PAYMENT-RESPONSE` headers. For a custom HTTP stack, `signVoucherPayment` and `signLienPayment` build the payload and `encodeHeader` / `decodeHeader` handle the header encoding.

## x402: serving a metered resource

`serveMeteredResource` starts an HTTP server (Node.js) that prices every request and accepts payment only from liens owed to the creditor, in the token it prices in. With a `VoucherMeter` it offers vouchers; without one it offers `encumbra-lien` only.

```ts
import { createPublicClient, createWalletClient, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { BASE_SEPOLIA_USDC, EncumbraClient, VoucherMeter, networkFor, serveMeteredResource } from "@encumbra/sdk";

const net = networkFor(84532); // Base Sepolia
const LIEN_REGISTRY: Address = "0x0000000000000000000000000000000000000000";
const creditor = privateKeyToAccount(process.env.CREDITOR_KEY as `0x${string}`);

// The wallet is the creditor: it submits charges and voucher settlements.
const encumbra = new EncumbraClient({
  publicClient: createPublicClient({ chain: net.chain, transport: http(net.defaultRpcUrl) }),
  walletClient: createWalletClient({ account: creditor, chain: net.chain, transport: http(net.defaultRpcUrl) }),
  address: LIEN_REGISTRY,
  chainId: net.chainId,
});

// Vouchers are checked locally and settled later in batches.
const meter = new VoucherMeter({
  encumbra,
  creditor: creditor.address,
  token: BASE_SEPOLIA_USDC,
  domain: await encumbra.voucherDomain(),
});

const server = await serveMeteredResource({
  encumbra,
  creditor: creditor.address,
  asset: BASE_SEPOLIA_USDC,
  price: 10_000n, // 0.01 USDC per request
  meter, // offers encumbra-voucher, and encumbra-lien unless offerLien is false
  handle: (query) => ({ symbol: query.get("symbol"), price: "3120.55" }),
  host: "0.0.0.0",
  port: 8402,
});
console.log("listening on", server.url);

// Settle the latest voucher per lien, one transaction for many requests.
setInterval(async () => {
  const report = await meter.settle();
  console.log(report);
}, 60_000);
```

The meter also exposes `accept`, `servedThrough`, `unsettled` and `exposure` for servers that run their own HTTP stack.

## Governance and KeeperBond

Protocol parameters live in `EncumbraGovernance` behind a timelock; existing liens keep the terms they opened on. Liquidation duty is assigned to bonded keepers in the `KeeperBond` module, and a keeper that misses its slot can be slashed by anyone. Both addresses are read from the chain when you do not pass them as the `governance` and `keeperBond` options.

```ts
import { createPublicClient, http, type Address } from "viem";
import { EncumbraClient, networkFor } from "@encumbra/sdk";

const net = networkFor(84532); // Base Sepolia
const LIEN_REGISTRY: Address = "0x0000000000000000000000000000000000000000";
const encumbra = new EncumbraClient({
  publicClient: createPublicClient({ chain: net.chain, transport: http(net.defaultRpcUrl) }),
  address: LIEN_REGISTRY,
  chainId: net.chainId,
});

// Governance: roles, fees, delay and pause state, and queued changes.
const gov = await encumbra.governanceState();
console.log(gov.admin, gov.delay, gov.usageFeeBps, gov.pausedUntil);
const pending = await encumbra.pendingChange("Params");
if (pending.eta > 0n && pending.eta <= (await encumbra.now())) {
  const execute = await encumbra.prepareExecuteChange("Params"); // unsigned, for the admin
  console.log(execute.summary);
}

// KeeperBond: keeper status, slashing checks and bonding calls.
const keeper: Address = "0x00000000000000000000000000000000000000d1";
console.log(await encumbra.keeperInfo(keeper), await encumbra.keeperBondParams());
const slash = await encumbra.checkSlash(1n);
console.log(slash.reason, slash.keeper, slash.amount);
const bond = await encumbra.prepareKeeperBond(); // approve the bond amount of ENC to the module first
console.log(bond.to, bond.summary);
```

Governance calls (`prepareQueueParams`, `prepareQueueOracle`, `prepareProposeAdmin`, `prepareExecuteChange`, `prepareCancelChange`, `preparePauseIntake`, ...) and keeper calls (`prepareKeeperBond`, `prepareKeeperUnbond`, `prepareKeeperWithdraw`, `prepareSlashMissed`, `prepareRecordExcuse`) all return unsigned `PreparedCall`s. `decodeGovernanceCalldata` and `decodeKeeperBondCalldata` decode them back for review.

## Sending from the client

An `EncumbraClient` constructed with a viem `walletClient` can sign and broadcast its own prepared calls with `exec(call)` or `execAndWait(call)`. It simulates first, refuses calls addressed to any contract other than the deployment's lien registry, governance and KeeperBond, and only runs on chains in `WRITE_ALLOWED_CHAIN_IDS` (Base Sepolia).

## ABIs

The contract ABIs are exported as `as const` arrays for use with viem directly, from the package root or the `@encumbra/sdk/abi` subpath: `encumbraLienAbi`, `encumbraGovernanceAbi`, `keeperBondAbi`, `chainlinkPriceOracleAbi`, `encumbraTokenAbi`, `encumbraAirdropAbi`, `encumbraAuctionAbi`.

## Documentation

- SDK reference: https://encumbra.ai/docs/sdk
- Protocol documentation and networks: https://encumbra.ai/docs

## License

[Apache-2.0](./LICENSE)
