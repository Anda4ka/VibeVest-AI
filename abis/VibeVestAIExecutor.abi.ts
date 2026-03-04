import { ABIDataTypes, BitcoinAbiTypes, OP_NET_ABI } from 'opnet';

export const VibeVestAIExecutorEvents = [];

export const VibeVestAIExecutorAbi = [
    {
        name: 'initialize',
        inputs: [{ name: 'publicVesting', type: ABIDataTypes.ADDRESS }],
        outputs: [{ name: 'success', type: ABIDataTypes.BOOL }],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'setPublicVesting',
        inputs: [{ name: 'newPublicVesting', type: ABIDataTypes.ADDRESS }],
        outputs: [{ name: 'success', type: ABIDataTypes.BOOL }],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'setRiskParams',
        inputs: [
            { name: 'maxAmountPerTx', type: ABIDataTypes.UINT256 },
            { name: 'globalMinBlocksGap', type: ABIDataTypes.UINT256 },
        ],
        outputs: [{ name: 'success', type: ABIDataTypes.BOOL }],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'setAllowedToken',
        inputs: [
            { name: 'token', type: ABIDataTypes.ADDRESS },
            { name: 'allowed', type: ABIDataTypes.UINT256 },
        ],
        outputs: [{ name: 'success', type: ABIDataTypes.BOOL }],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'executeIntent',
        inputs: [
            { name: 'user', type: ABIDataTypes.ADDRESS },
            { name: 'action', type: ABIDataTypes.UINT256 },
            { name: 'token', type: ABIDataTypes.ADDRESS },
            { name: 'amount', type: ABIDataTypes.UINT256 },
            { name: 'beneficiary', type: ABIDataTypes.ADDRESS },
            { name: 'durationDays', type: ABIDataTypes.UINT256 },
            { name: 'minClaimable', type: ABIDataTypes.UINT256 },
            { name: 'minBlocksGap', type: ABIDataTypes.UINT256 },
            { name: 'nonce', type: ABIDataTypes.UINT256 },
            { name: 'deadline', type: ABIDataTypes.UINT256 },
        ],
        outputs: [{ name: 'success', type: ABIDataTypes.BOOL }],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'getRiskParams',
        inputs: [],
        outputs: [
            { name: 'maxAmountPerTx', type: ABIDataTypes.UINT256 },
            { name: 'globalMinBlocksGap', type: ABIDataTypes.UINT256 },
        ],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'getLastExecutedBlock',
        inputs: [{ name: 'user', type: ABIDataTypes.ADDRESS }],
        outputs: [{ name: 'blockNumber', type: ABIDataTypes.UINT256 }],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'getNextNonce',
        inputs: [{ name: 'user', type: ABIDataTypes.ADDRESS }],
        outputs: [{ name: 'nonce', type: ABIDataTypes.UINT256 }],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'isTokenAllowed',
        inputs: [{ name: 'token', type: ABIDataTypes.ADDRESS }],
        outputs: [{ name: 'allowed', type: ABIDataTypes.UINT256 }],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'getPublicVesting',
        inputs: [],
        outputs: [{ name: 'publicVesting', type: ABIDataTypes.ADDRESS }],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'owner',
        inputs: [],
        outputs: [{ name: 'ownerAddress', type: ABIDataTypes.ADDRESS }],
        type: BitcoinAbiTypes.Function,
    },
    ...VibeVestAIExecutorEvents,
    ...OP_NET_ABI,
];

export default VibeVestAIExecutorAbi;
