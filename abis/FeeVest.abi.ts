import { ABIDataTypes, BitcoinAbiTypes, OP_NET_ABI } from 'opnet';

export const FeeVestEvents = [];

export const FeeVestAbi = [
    {
        name: 'initialize',
        inputs: [{ name: 'revenueToken', type: ABIDataTypes.ADDRESS }],
        outputs: [{ name: 'success', type: ABIDataTypes.BOOL }],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'depositAndVest',
        inputs: [
            { name: 'amount', type: ABIDataTypes.UINT256 },
            { name: 'beneficiary', type: ABIDataTypes.ADDRESS },
            { name: 'cliffDuration', type: ABIDataTypes.UINT256 },
            { name: 'vestingDuration', type: ABIDataTypes.UINT256 },
        ],
        outputs: [{ name: 'success', type: ABIDataTypes.BOOL }],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'release',
        inputs: [],
        outputs: [{ name: 'amount', type: ABIDataTypes.UINT256 }],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'depositRevenue',
        inputs: [{ name: 'amount', type: ABIDataTypes.UINT256 }],
        outputs: [{ name: 'success', type: ABIDataTypes.BOOL }],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'claimRevenue',
        inputs: [],
        outputs: [{ name: 'amount', type: ABIDataTypes.UINT256 }],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'getVesting',
        inputs: [{ name: 'beneficiary', type: ABIDataTypes.ADDRESS }],
        outputs: [
            { name: 'totalAmount', type: ABIDataTypes.UINT256 },
            { name: 'startBlock', type: ABIDataTypes.UINT256 },
            { name: 'cliffDuration', type: ABIDataTypes.UINT256 },
            { name: 'vestingDuration', type: ABIDataTypes.UINT256 },
            { name: 'released', type: ABIDataTypes.UINT256 },
            { name: 'releasable', type: ABIDataTypes.UINT256 },
        ],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'getPendingRelease',
        inputs: [{ name: 'beneficiary', type: ABIDataTypes.ADDRESS }],
        outputs: [{ name: 'amount', type: ABIDataTypes.UINT256 }],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'getClaimableRevenue',
        inputs: [{ name: 'beneficiary', type: ABIDataTypes.ADDRESS }],
        outputs: [{ name: 'amount', type: ABIDataTypes.UINT256 }],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'totalLocked',
        inputs: [],
        outputs: [{ name: 'amount', type: ABIDataTypes.UINT256 }],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'totalRevenueDeposited',
        inputs: [],
        outputs: [{ name: 'amount', type: ABIDataTypes.UINT256 }],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'revenueToken',
        inputs: [],
        outputs: [{ name: 'token', type: ABIDataTypes.ADDRESS }],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'owner',
        inputs: [],
        outputs: [{ name: 'ownerAddress', type: ABIDataTypes.ADDRESS }],
        type: BitcoinAbiTypes.Function,
    },
    ...FeeVestEvents,
    ...OP_NET_ABI,
];

export default FeeVestAbi;
