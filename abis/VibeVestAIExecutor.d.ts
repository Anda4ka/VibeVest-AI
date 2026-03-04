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
 * @description Represents the result of the setPublicVesting function call.
 */
export type SetPublicVesting = CallResult<
    {
        success: boolean;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the setRiskParams function call.
 */
export type SetRiskParams = CallResult<
    {
        success: boolean;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the setAllowedToken function call.
 */
export type SetAllowedToken = CallResult<
    {
        success: boolean;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the executeIntent function call.
 */
export type ExecuteIntent = CallResult<
    {
        success: boolean;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the getRiskParams function call.
 */
export type GetRiskParams = CallResult<
    {
        maxAmountPerTx: bigint;
        globalMinBlocksGap: bigint;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the getLastExecutedBlock function call.
 */
export type GetLastExecutedBlock = CallResult<
    {
        blockNumber: bigint;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the getNextNonce function call.
 */
export type GetNextNonce = CallResult<
    {
        nonce: bigint;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the isTokenAllowed function call.
 */
export type IsTokenAllowed = CallResult<
    {
        allowed: bigint;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the getPublicVesting function call.
 */
export type GetPublicVesting = CallResult<
    {
        publicVesting: Address;
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
// IVibeVestAIExecutor
// ------------------------------------------------------------------
export interface IVibeVestAIExecutor extends IOP_NETContract {
    initialize(publicVesting: Address): Promise<Initialize>;
    setPublicVesting(newPublicVesting: Address): Promise<SetPublicVesting>;
    setRiskParams(maxAmountPerTx: bigint, globalMinBlocksGap: bigint): Promise<SetRiskParams>;
    setAllowedToken(token: Address, allowed: bigint): Promise<SetAllowedToken>;
    executeIntent(
        user: Address,
        action: bigint,
        token: Address,
        amount: bigint,
        beneficiary: Address,
        durationDays: bigint,
        minClaimable: bigint,
        minBlocksGap: bigint,
        nonce: bigint,
        deadline: bigint,
    ): Promise<ExecuteIntent>;
    getRiskParams(): Promise<GetRiskParams>;
    getLastExecutedBlock(user: Address): Promise<GetLastExecutedBlock>;
    getNextNonce(user: Address): Promise<GetNextNonce>;
    isTokenAllowed(token: Address): Promise<IsTokenAllowed>;
    getPublicVesting(): Promise<GetPublicVesting>;
    owner(): Promise<Owner>;
}
