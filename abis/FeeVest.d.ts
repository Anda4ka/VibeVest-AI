import { Address, AddressMap, ExtendedAddressMap, SchnorrSignature } from '@btc-vision/transaction';
import { CallResult, OPNetEvent, IOP_NETContract } from 'opnet';

// ------------------------------------------------------------------
// Event Definitions
// ------------------------------------------------------------------

// ------------------------------------------------------------------
// Call Results
// ------------------------------------------------------------------

/**
 * @description Represents the result of the initialize function call.
 */
export type Initialize = CallResult<
    {
        success: boolean;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the depositAndVest function call.
 */
export type DepositAndVest = CallResult<
    {
        success: boolean;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the release function call.
 */
export type Release = CallResult<
    {
        amount: bigint;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the depositRevenue function call.
 */
export type DepositRevenue = CallResult<
    {
        success: boolean;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the claimRevenue function call.
 */
export type ClaimRevenue = CallResult<
    {
        amount: bigint;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the getVesting function call.
 */
export type GetVesting = CallResult<
    {
        totalAmount: bigint;
        startBlock: bigint;
        cliffDuration: bigint;
        vestingDuration: bigint;
        released: bigint;
        releasable: bigint;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the getPendingRelease function call.
 */
export type GetPendingRelease = CallResult<
    {
        amount: bigint;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the getClaimableRevenue function call.
 */
export type GetClaimableRevenue = CallResult<
    {
        amount: bigint;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the totalLocked function call.
 */
export type TotalLocked = CallResult<
    {
        amount: bigint;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the totalRevenueDeposited function call.
 */
export type TotalRevenueDeposited = CallResult<
    {
        amount: bigint;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the revenueToken function call.
 */
export type RevenueToken = CallResult<
    {
        token: Address;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the owner function call.
 */
export type Owner = CallResult<
    {
        ownerAddress: Address;
    },
    OPNetEvent<never>[]
>;

// ------------------------------------------------------------------
// IFeeVest
// ------------------------------------------------------------------
export interface IFeeVest extends IOP_NETContract {
    initialize(revenueToken: Address): Promise<Initialize>;
    depositAndVest(
        amount: bigint,
        beneficiary: Address,
        cliffDuration: bigint,
        vestingDuration: bigint,
    ): Promise<DepositAndVest>;
    release(): Promise<Release>;
    depositRevenue(amount: bigint): Promise<DepositRevenue>;
    claimRevenue(): Promise<ClaimRevenue>;
    getVesting(beneficiary: Address): Promise<GetVesting>;
    getPendingRelease(beneficiary: Address): Promise<GetPendingRelease>;
    getClaimableRevenue(beneficiary: Address): Promise<GetClaimableRevenue>;
    totalLocked(): Promise<TotalLocked>;
    totalRevenueDeposited(): Promise<TotalRevenueDeposited>;
    revenueToken(): Promise<RevenueToken>;
    owner(): Promise<Owner>;
}
