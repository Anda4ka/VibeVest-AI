/**
 * FeeVest + VibeVestAIExecutor — Full Test Flow
 *
 * Steps:
 *   1. Mint REV tokens to owner
 *   2. increaseAllowance: owner → FeeVest (for depositAndVest)
 *   3. depositAndVest: 1000 REV, cliff=5 blocks, duration=50 blocks
 *   4. Check vesting schedule
 *   5. depositRevenue: 100 REV into FeeVest pool
 *   (release/claimRevenue require waiting for cliff — shown as manual steps)
 *
 * Usage (PowerShell):
 *   $env:OWNER_MNEMONIC="word1 word2 ... word12"
 *   $env:ACCOUNT_INDEX="1"
 *   node test/test-flow.mjs
 */

import { CallResult, getContract, JSONRpcProvider, OP_20_ABI } from 'opnet';
import { Address, AddressTypes, MLDSASecurityLevel, Mnemonic } from '@btc-vision/transaction';
import { networks } from '@btc-vision/bitcoin';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const FEEVEST_ABI_JSON  = require('../abis/FeeVest.abi.json');
const FEETOKEN_ABI_JSON = require('../abis/FeeToken.abi.json');

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const NETWORK = networks.opnetTestnet;
const RPC_URL = 'https://testnet.opnet.org';

const FEEVEST_ADDR  = '0x83d8c452bdaf0b13ca1e8867a1f0dd67840609601da994d43c67abb3482f24a2';
const FEETOKEN_ADDR = '0xdbe1fd1a52d80579d7f1ac7bac951b38084668944168689c3a011a482ccc9793';

const MINT_AMOUNT    = 10_000n * 10n ** 18n;  // 10 000 REV
const VEST_AMOUNT    = 1_000n  * 10n ** 18n;  // 1 000 REV to vest
const REVENUE_AMOUNT = 100n   * 10n ** 18n;   // 100 REV as protocol revenue
const CLIFF_BLOCKS   = 5n;
const VEST_DURATION  = 50n;

// ─── Helpers ─────────────────────────────────────────────────────────────────
function log(msg) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function normalizeAbi(abi) {
    return abi.map(f => ({ ...f, type: f.type.toLowerCase() }));
}

async function sendTx(simulation, wallet, label) {
    log(`  → sending ${label}…`);
    const receipt = await simulation.sendTransaction({
        signer:      wallet.keypair,
        mldsaSigner: wallet.mldsaKeypair,
        refundTo:    wallet.p2tr,
        maximumAllowedSatToSpend: 150_000n,
        feeRate:     10,
        network:     NETWORK,
    });
    const txId = receipt?.transactionId ?? '(pending)';
    log(`  ✓ ${label} — ${txId}`);
    return txId;
}

/**
 * Send a transaction bypassing simulation.
 * Used for methods that do cross-contract calls (transferFrom) which cause
 * "out of memory" on OPNet testnet when simulated.
 * We encode the calldata manually and construct a CallResult without simulating.
 */
async function sendTxDirect(contract, contractP2op, functionName, args, wallet, provider, label) {
    log(`  [direct] encoding ${label}…`);
    const calldata = contract.encodeCalldata(functionName, args);
    const contractAddress = typeof contract.address === 'string'
        ? Address.fromString(contract.address)
        : contract.address;

    const fakeResult = new CallResult(
        {
            result:       new Uint8Array(1),
            accessList:   {},
            events:       {},
            revert:       undefined,
            estimatedGas: '50000',
            specialGas:   '0',
        },
        provider,
    );
    fakeResult.setCalldata(calldata);
    fakeResult.setTo(contractP2op, contractAddress);
    fakeResult.setGasEstimation(5000n, 0n);

    log(`  → sending ${label}…`);
    const receipt = await fakeResult.sendTransaction({
        signer:      wallet.keypair,
        mldsaSigner: wallet.mldsaKeypair,
        refundTo:    wallet.p2tr,
        maximumAllowedSatToSpend: 150_000n,
        minGas:      5000n,
        feeRate:     10,
        network:     NETWORK,
    });
    const txId = receipt?.transactionId ?? '(pending)';
    log(`  ✓ ${label} — ${txId}`);
    return txId;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
    const phrase = process.env.OWNER_MNEMONIC ?? '';
    if (!phrase) {
        console.error('[ERROR] Set $env:OWNER_MNEMONIC and $env:ACCOUNT_INDEX=1');
        process.exit(1);
    }

    const accountIndex = parseInt(process.env.ACCOUNT_INDEX ?? '1', 10);
    const mnemonic = new Mnemonic(phrase, '', NETWORK, MLDSASecurityLevel.LEVEL2);
    const wallet   = mnemonic.deriveOPWallet(AddressTypes.P2TR, accountIndex);

    if (wallet.p2tr !== 'opt1ps7vxl0vfcrl8uwvwrqntaqlvsmy5rr7ayug3luncwu38dt7ynfcssfhr2k') {
        console.error(`[ERROR] Wrong account. Got: ${wallet.p2tr}`);
        process.exit(1);
    }

    const provider  = new JSONRpcProvider({ url: RPC_URL, network: NETWORK });
    const ownerAddr = wallet.address;

    log(`Owner: ${wallet.p2tr}`);
    log(`FeeVest:  ${FEEVEST_ADDR}`);
    log(`FeeToken: ${FEETOKEN_ADDR}`);
    log('');

    // ── Build contract proxies ─────────────────────────────────────────────────
    const feeTokenAbi = [
        ...normalizeAbi(FEETOKEN_ABI_JSON.functions),  // mint
        ...OP_20_ABI,                                  // transfer, increaseAllowance, balanceOf, etc.
    ];
    const feeVestAbi = normalizeAbi(FEEVEST_ABI_JSON.functions);

    const token  = getContract(Address.fromString(FEETOKEN_ADDR), feeTokenAbi,  provider, NETWORK, ownerAddr);
    const vault  = getContract(Address.fromString(FEEVEST_ADDR),  feeVestAbi,   provider, NETWORK, ownerAddr);

    // ── 0. Check current balance ────────────────────────────────────────────────
    log('── Check: balanceOf owner ───────────────────────────────────');
    const balResult = await getContract(
        Address.fromString(FEETOKEN_ADDR), OP_20_ABI, provider, NETWORK, Address.dead()
    ).balanceOf(ownerAddr);
    const currentBal = balResult?.properties?.balance ?? 0n;
    log(`  balance: ${currentBal / 10n ** 18n} REV`);
    log('');

    // ── 1. Mint tokens (if balance < VEST_AMOUNT + REVENUE_AMOUNT) ────────────
    const needed = VEST_AMOUNT + REVENUE_AMOUNT;
    if (currentBal < needed) {
        log(`── Step 1: mint(owner, ${MINT_AMOUNT / 10n**18n} REV) ─────────────────────`);
        const sim = await token.mint(ownerAddr, MINT_AMOUNT);
        await sendTx(sim, wallet, 'mint');
        log('');
        log('Waiting 20s for block confirmation…');
        await sleep(20_000);
    } else {
        log('── Step 1: mint — SKIP (sufficient balance) ─────────────────');
        log('');
    }

    // ── 2. increaseAllowance for FeeVest ──────────────────────────────────────
    log(`── Step 2: increaseAllowance(FeeVest, ${(VEST_AMOUNT + REVENUE_AMOUNT) / 10n**18n} REV) ──`);
    const simAllow = await token.increaseAllowance(
        Address.fromString(FEEVEST_ADDR),
        VEST_AMOUNT + REVENUE_AMOUNT,
    );
    await sendTx(simAllow, wallet, 'increaseAllowance');
    log('');
    await sleep(15_000);

    // ── 3. depositAndVest ──────────────────────────────────────────────────────
    // NOTE: cross-contract transferFrom causes OOM in simulation; use direct mode.
    log(`── Step 3: depositAndVest(${VEST_AMOUNT / 10n**18n} REV, cliff=${CLIFF_BLOCKS}, dur=${VEST_DURATION}) ─`);
    await sendTxDirect(
        vault,
        'opt1sqqcgjuyshp4x4p4epuve9th60sxg6t3zhczv5ntm',
        'depositAndVest',
        [VEST_AMOUNT, ownerAddr, CLIFF_BLOCKS, VEST_DURATION],
        wallet, provider,
        'depositAndVest',
    );
    log('');
    await sleep(15_000);

    // ── 4. depositRevenue ─────────────────────────────────────────────────────
    // NOTE: also uses cross-contract transferFrom; direct mode required.
    log(`── Step 4: depositRevenue(${REVENUE_AMOUNT / 10n**18n} REV) ─────────────────`);
    await sendTxDirect(
        vault,
        'opt1sqqcgjuyshp4x4p4epuve9th60sxg6t3zhczv5ntm',
        'depositRevenue',
        [REVENUE_AMOUNT],
        wallet, provider,
        'depositRevenue',
    );
    log('');

    // ── 5. Read vesting schedule ───────────────────────────────────────────────
    log('── Step 5: getVesting(owner) ────────────────────────────────');
    await sleep(10_000);
    const vestingResult = await getContract(
        Address.fromString(FEEVEST_ADDR), feeVestAbi, provider, NETWORK, Address.dead()
    ).getVesting(ownerAddr);
    log(`  vesting: ${JSON.stringify(vestingResult?.properties ?? vestingResult)}`);
    log('');

    log('══════════════════════════════════════════════════════════════');
    log('✓ Test flow complete!');
    log('');
    log('Next steps (after cliff passes — wait ~5 blocks):');
    log('  run: node test/test-release.mjs   # calls release() + claimRevenue()');
}

main().catch(err => {
    console.error('\n[ERROR]', err?.message ?? err);
    process.exit(1);
});
