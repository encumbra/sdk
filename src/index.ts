// @encumbra/sdk: the viem client for the Encumbra lien primitive.
//
// How agents and apps use it:
//   - read lien state (available, isServiceable, healthFactor, agentStats, pastDueSince, ...)
//   - prepare* -> an unsigned PreparedCall for a wallet/policy engine to sign, for the lien,
//     governance (queued changes, admin handover, intake pause) and the keeper bond module
//   - buildChargeAuth -> EIP-712 typed data the *agent* signs to authorize a draw
//   - buildOpenConsent / buildLeaseScheduleConsent -> EIP-712 typed data the *agent* signs to
//     agree to be named on a lien, or to an installment schedule
//   - computeTermsHash -> the governance terms hash every open and consent carries
//   - x402: LienPayer (agent) and serveMeteredResource + VoucherMeter (creditor) for HTTP
//     resources paid from a credit line
//   - exec (optional, testnet-only) -> sign + broadcast with a provided wallet
//
// Signing stays in the wallet layer. The default surface moves no funds on its own.
export {
  EncumbraClient,
  type EncumbraClientOptions,
  type EncumbraDomain,
  type ChargeAuth,
  type ExecResult,
  type SettleVouchersResult,
  type GovernanceState,
} from "./client.ts";
export {
  encumbraLienAbi,
  encumbraGovernanceAbi,
  chainlinkPriceOracleAbi,
  keeperBondAbi,
  encumbraTokenAbi,
  encumbraAirdropAbi,
  encumbraAuctionAbi,
} from "./abi.ts";
export {
  NETWORKS,
  networkFor,
  DEFAULT_CHAIN_ID,
  BASE_SEPOLIA_USDC,
  WRITE_ALLOWED_CHAIN_IDS,
  isWriteAllowed,
  type EncumbraNetwork,
} from "./chains.ts";
export {
  buildChargeTypedData,
  CHARGE_TYPES,
  CHARGE_DOMAIN_NAME,
  CHARGE_DOMAIN_VERSION,
  DEFAULT_CHARGE_TTL_SECONDS,
  type BuildChargeTypedDataParams,
} from "./charge.ts";
export {
  buildOpenConsentTypedData,
  buildOpenAssetConsentTypedData,
  buildLeaseScheduleTypedData,
  computeTermsHash,
  termsOfLien,
  requireTermsHash,
  eip712TypeString,
  eip712TypeHash,
  consentNonceMasks,
  isNonceSet,
  randomConsentNonce,
  OPEN_CONSENT_TYPES,
  OPEN_ASSET_CONSENT_TYPES,
  LEASE_SCHEDULE_TYPES,
  TERMS_TYPES,
  TERMS_TYPEHASH,
  DEFAULT_CONSENT_TTL_SECONDS,
  type ConsentContext,
  type OpenConsent,
  type OpenConsentTypedData,
  type OpenAssetConsentTypedData,
  type LeaseScheduleConsent,
  type LeaseScheduleTypedData,
} from "./consent.ts";
export {
  decodeEncumbraCalldata,
  decodeGovernanceCalldata,
  decodeKeeperBondCalldata,
  type DecodedCall,
} from "./decode.ts";
export {
  encodeAssetClass,
  decodeAssetClass,
  statusName,
  formatHealthFactor,
  formatUnits,
} from "./format.ts";
export { underwrite, type UnderwriteInput, type UnderwriteResult } from "./underwriter.ts";
export {
  prepareOpen,
  prepareOpenAsset,
  prepareOpenWithConsent,
  prepareOpenAssetWithConsent,
  prepareCancelConsentNonces,
  prepareCharge,
  prepareChargeWithAuth,
  prepareRepay,
  prepareWithdrawCreditor,
  prepareWithdrawCreditorTo,
  prepareWithdrawProtocol,
  prepareAddCollateral,
  prepareFreeze,
  prepareUnfreeze,
  prepareLiquidate,
  prepareLiquidateAsset,
  prepareClose,
  prepareCloseTo,
  preparePayInstallment,
  prepareSetLeaseSchedule,
  prepareReportOracleFailure,
  prepareClearOracleFailure,
  prepareMigrateOracle,
  prepareSettleVoucher,
  prepareSettleVouchers,
  type CallContext,
} from "./encode.ts";
export {
  GOVERNANCE_OPS,
  decodeChangeArg,
  prepareQueueParams,
  prepareQueueOracle,
  prepareQueueCouncil,
  prepareQueueKeeperModule,
  prepareQueueMinCreditLimit,
  prepareProposeAdmin,
  prepareExecuteChange,
  prepareCancelChange,
  prepareAcceptAdmin,
  prepareRevokePendingAdmin,
  preparePauseIntake,
  prepareUnpauseIntake,
  type GovernanceOp,
  type PendingChange,
  type DecodedChange,
} from "./governance.ts";
export {
  prepareKeeperBond,
  prepareKeeperUnbond,
  prepareKeeperWithdraw,
  prepareSlashMissed,
  prepareRecordExcuse,
  type KeeperInfo,
  type KeeperBondParams,
  type SlashCheck,
} from "./keeper.ts";
export {
  VOUCHER_TYPES,
  VOUCHER_REJECTION,
  voucherDomain,
  signVoucher,
  recoverVoucherSigner,
  voucherSignature,
  splitVoucherSignature,
  type TypedDataSigner,
  type VoucherDomain,
  type UnsignedVoucher,
  type SignedVoucher,
} from "./voucher.ts";
export {
  VoucherMeter,
  type MeterChain,
  type MeterOptions,
  type RefusalCode,
  type AcceptResult,
  type SettleReport,
} from "./voucher-meter.ts";
export {
  X402_VERSION,
  HEADER_REQUIRED,
  HEADER_SIGNATURE,
  HEADER_RESPONSE,
  SCHEME_VOUCHER,
  SCHEME_LIEN,
  ERRORS as X402_ERRORS,
  encodeHeader,
  decodeHeader,
  chainIdOf,
  serveMeteredResource,
  x402Fetch,
  signLienPayment,
  signVoucherPayment,
  LienPayer,
  X402PayerRefusal,
  MAX_REDIRECTS,
  MAX_CHARGE_TIMEOUT_SECS,
  type PayerRefusalCode,
  type EncumbraScheme,
  type ResourceInfo,
  type PaymentRequirements,
  type PaymentRequired,
  type LienPayload,
  type VoucherPayload,
  type PaymentPayload,
  type SettlementResponse,
  type ResourceChain,
  type ServeOptions,
  type X402Server,
  type X402Response,
  type LienPayerOptions,
} from "./x402.ts";
export {
  STATUS,
  type LienStatus,
  type Role,
  type EncumbraContract,
  type LienView,
  type Terms,
  type OracleFailure,
  type AgentStats,
  type LiquidationResult,
  type OpenParams,
  type OpenAssetParams,
  type PreparedCall,
  type ChargeTypedData,
} from "./types.ts";
