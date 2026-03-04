/**
 * FeeVest — End-to-End Test Script (OPNet Testnet)
 *
 * Runs the full public vesting + revenue share flow:
 *   1. Initialize vault with FeeToken address
 *   2. Depositor (public) locks tokens for a beneficiary
 *   3. Revenue depositor sends protocol fees
 *   4. Poll until cliff passes
 *   5. Beneficiary releases vested tokens
 *   6. Beneficiary claims revenue share
 *   7. Verify final state
 *
 * Usage:
 *   npx ts-node test/test-feevest-flow.ts
 *
 * Requires environment variables (or edit the CONFIG block below):
 *   OWNER_WIF       — WIF private key of the FeeVest deployer (owner)
 *   DEPOSITOR_WIF   — WIF private key of the token depositor (public role)
 *   BENEFICIARY_WIF — WIF private key of the vesting beneficiary
 *   FEEVEST_ADDR    — FeeVest contract address (0x... hex)
 *   FEETOKEN_ADDR   — FeeToken contract address (0x... hex)
 */

import {
    getContract,
    IWallet,
    JSONRpcProvider,
    networks,
    Wallet,
} from '@btc-vision/btc-runtime/runtime';
import { FeeVestAbi } from '../abis/FeeVest.abi';

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const RPC_URL        = 'https://testnet.opnet.org';
const NETWORK        = networks.opnetTestnet;

// Replace with deployed addresses or set via env
const FEEVEST_ADDR   = process.env.FEEVEST_ADDR  ?? '0xYOUR_FEEVEST_ADDRESS';
const FEETOKEN_ADDR  = process.env.FEETOKEN_ADDR ?? '0xYOUR_FEETOKEN_ADDRESS';

// Vesting parameters
const VEST_AMOUNT    = 1_000n * 10n ** 18n;  // 1 000 FEE
const CLIFF_BLOCKS   = 10n;                  // 10 blocks (~10 mins on testnet)
const VEST_DURATION  = 100n;                 // 100 blocks linear vest
const REVENUE_AMOUNT = 500n * 10n ** 18n;   // 500 FEE protocol fee

// Poll interval when waiting for the cliff
const POLL_MS = 15_000;

// ─── OP_20 minimal ABI (for approve / increaseAllowance) ─────────────────────
const OP20_ABI = [
    {
        name: 'increaseAllowance',
        inputs: [
            { name: 'spender', type: 'ADDRESS' },
            { name: 'addedValue', type: 'UINT256' },
        ],
        outputs: [{ name: 'success', type: 'BOOL' }],
        type: 'Function',
    },
    {
        name: 'balanceOf',
        inputs: [{ name: 'account', type: 'ADDRESS' }],
        outputs: [{ name: 'balance', type: 'UINT256' }],
        type: 'Function',
    },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────
function log(msg: string): void {
    console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function sendTx(
    contract: ReturnType<typeof getContract>,
    method: string,
    args: unknown[],
    label: string,
): Promise<void> {
    log(`Sending ${label}…`);
    const result = await (contract as any)[method](...args);
    if (!result) throw new Error(`${label}: no result`);
    log(`✓ ${label} confirmed`);
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
    // Load wallets
    const ownerWif       = process.env.OWNER_WIF       ?? '';
    const depositorWif   = process.env.DEPOSITOR_WIF   ?? '';
    const beneficiaryWif = process.env.BENEFICIARY_WIF ?? '';

    if (!ownerWif || !depositorWif || !beneficiaryWif) {
        throw new Error('Set OWNER_WIF, DEPOSITOR_WIF, BENEFICIARY_WIF env vars');
    }

    const provider     = new JSONRpcProvider(RPC_URL, NETWORK);
    const ownerWallet: IWallet      = Wallet.fromWIF(ownerWif, NETWORK);
    const depositorWallet: IWallet  = Wallet.fromWIF(depositorWif, NETWORK);
    const beneficiaryWallet: IWallet = Wallet.fromWIF(beneficiaryWif, NETWORK);

    const beneficiaryAddr = beneficiaryWallet.address;

    log(`Owner:       ${ownerWallet.address}`);
    log(`Depositor:   ${depositorWallet.address}`);
    log(`Beneficiary: ${beneficiaryAddr}`);
    log(`FeeVest:     ${FEEVEST_ADDR}`);
    log(`FeeToken:    ${FEETOKEN_ADDR}`);

    // ── 1. Initialize vault ───────────────────────────────────────────────────
    log('\n── Step 1: Initialize FeeVest ───────────────────────────────');
    const vaultAsOwner = getContract(FEEVEST_ADDR, FeeVestAbi, provider, NETWORK, ownerWallet);
    await sendTx(vaultAsOwner, 'initialize', [FEETOKEN_ADDR], 'initialize(feeToken)');

    // ── 2. Depositor locks tokens for beneficiary ─────────────────────────────
    log('\n── Step 2: Depositor locks tokens ───────────────────────────');
    const tokenAsDepositor = getContract(FEETOKEN_ADDR, OP20_ABI, provider, NETWORK, depositorWallet);
    await sendTx(
        tokenAsDepositor,
        'increaseAllowance',
        [FEEVEST_ADDR, VEST_AMOUNT],
        'increaseAllowance(vault, vestAmount)',
    );

    const vaultAsDepositor = getContract(FEEVEST_ADDR, FeeVestAbi, provider, NETWORK, depositorWallet);
    await sendTx(
        vaultAsDepositor,
        'depositAndVest',
        [VEST_AMOUNT, beneficiaryAddr, CLIFF_BLOCKS, VEST_DURATION],
        `depositAndVest(${VEST_AMOUNT}, beneficiary, cliff=${CLIFF_BLOCKS}, dur=${VEST_DURATION})`,
    );

    // ── 3. Revenue depositor sends protocol fees ─────────────────────────────
    log('\n── Step 3: Deposit revenue ───────────────────────────────────');
    const tokenAsOwner = getContract(FEETOKEN_ADDR, OP20_ABI, provider, NETWORK, ownerWallet);
    await sendTx(
        tokenAsOwner,
        'increaseAllowance',
        [FEEVEST_ADDR, REVENUE_AMOUNT],
        'increaseAllowance(vault, revenueAmount)',
    );
    await sendTx(
        vaultAsOwner,
        'depositRevenue',
        [REVENUE_AMOUNT],
        `depositRevenue(${REVENUE_AMOUNT})`,
    );

    // ── 4. Poll until cliff passes ────────────────────────────────────────────
    log('\n── Step 4: Waiting for cliff ────────────────────────────────');
    const vaultView = getContract(FEEVEST_ADDR, FeeVestAbi, provider, NETWORK, beneficiaryWallet);
    let cliffPassed = false;
    while (!cliffPassed) {
        const result = await (vaultView as any).getPendingRelease(beneficiaryAddr);
        const releasable: bigint = result?.properties?.amount ?? 0n;
        log(`  Releasable: ${releasable} wei — ${releasable > 0n ? 'CLIFF PASSED' : 'waiting…'}`);
        if (releasable > 0n) {
            cliffPassed = true;
        } else {
            await sleep(POLL_MS);
        }
    }

    // ── 5. Beneficiary releases vested tokens ────────────────────────────────
    log('\n── Step 5: Beneficiary calls release() ──────────────────────');
    const vaultAsBeneficiary = getContract(FEEVEST_ADDR, FeeVestAbi, provider, NETWORK, beneficiaryWallet);
    await sendTx(vaultAsBeneficiary, 'release', [], 'release()');

    // ── 6. Beneficiary claims revenue ────────────────────────────────────────
    log('\n── Step 6: Beneficiary claims revenue ───────────────────────');
    await sendTx(vaultAsBeneficiary, 'claimRevenue', [], 'claimRevenue()');

    // ── 7. Verify final state ─────────────────────────────────────────────────
    log('\n── Step 7: Verify state ─────────────────────────────────────');
    const vestInfo = await (vaultView as any).getVesting(beneficiaryAddr);
    const props = vestInfo?.properties ?? {};
    log(`  totalAmount:     ${props.totalAmount}`);
    log(`  released:        ${props.released}`);
    log(`  releasable:      ${props.releasable}`);

    const claimable = await (vaultView as any).getClaimableRevenue(beneficiaryAddr);
    log(`  claimableRevenue: ${claimable?.properties?.amount}`);

    const totalLocked = await (vaultView as any).totalLocked();
    log(`  globalTotalLocked: ${totalLocked?.properties?.amount}`);

    log('\n✓ Full FeeVest flow completed successfully.');
}

main().catch(err => {
    console.error('Test failed:', err.message ?? err);
    process.exit(1);
});
