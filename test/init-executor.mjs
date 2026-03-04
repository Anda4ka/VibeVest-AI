/**
 * VibeVestAIExecutor — Post-Deploy Initialization Script (plain ESM JS)
 *
 * Usage (PowerShell):
 *   $env:OWNER_MNEMONIC="word1 word2 ... word12"
 *   $env:ACCOUNT_INDEX="1"          # Account 2 = index 1 (default)
 *   node test/init-executor.mjs
 *
 * Usage (bash/Git Bash):
 *   OWNER_MNEMONIC="word1 word2 ..." ACCOUNT_INDEX=1 node test/init-executor.mjs
 *
 * NOTE: Export the seed phrase from Account 1 in OP_NET wallet.
 *       Account 2 (the deployer) is derived at ACCOUNT_INDEX=1 from the same mnemonic.
 */

import { getContract, JSONRpcProvider } from 'opnet';
import { Address, AddressTypes, MLDSASecurityLevel, Mnemonic } from '@btc-vision/transaction';
import { networks } from '@btc-vision/bitcoin';

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const NETWORK   = networks.opnetTestnet;
const RPC_URL   = 'https://testnet.opnet.org';

const EXECUTOR_ADDR = '0xeb7f4c354717a568d12b491d7ff2ad957ea36f7ba7d52941d06bef646badf546';
const FEEVEST_ADDR  = '0x813078152d97d3181b8e52f64f24451aed1916b7d6c459c5146b098045080089';
const FEETOKEN_ADDR = '0xdbe1fd1a52d80579d7f1ac7bac951b38084668944168689c3a011a482ccc9793';

const MAX_AMOUNT_PER_TX     = 1_000_000n * 10n ** 18n;
const GLOBAL_MIN_BLOCKS_GAP = 5n;

// Load ABI directly from JSON to avoid TS import issues
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const ABI = require('../abis/VibeVestAIExecutor.abi.json');

// ─── Helpers ─────────────────────────────────────────────────────────────────
function log(msg) {
    console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

async function sendTx(simulation, wallet, label) {
    log(`Sending ${label}…`);
    const receipt = await simulation.sendTransaction({
        signer:       wallet.keypair,
        mldsaSigner:  wallet.mldsaKeypair,
        refundTo:     wallet.p2tr,
        maximumAllowedSatToSpend: 100_000n,
        feeRate:      10,
        network:      NETWORK,
    });
    log(`✓ ${label} — txId: ${receipt?.transactionId ?? '(confirmed)'}`);
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
    const phrase = process.env.OWNER_MNEMONIC ?? '';
    if (!phrase) {
        console.error('\n[ERROR] OWNER_MNEMONIC is not set.\n');
        console.error('PowerShell:');
        console.error('  $env:OWNER_MNEMONIC="word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12"');
        console.error('  node test/init-executor.mjs\n');
        process.exit(1);
    }

    // Account 2 = index 1 from the mnemonic (Account 1 = index 0)
    const accountIndex = parseInt(process.env.ACCOUNT_INDEX ?? '1', 10);

    const mnemonic = new Mnemonic(phrase, '', NETWORK, MLDSASecurityLevel.LEVEL2);
    const wallet   = mnemonic.deriveOPWallet(AddressTypes.P2TR, accountIndex);

    const provider = new JSONRpcProvider({ url: RPC_URL, network: NETWORK });

    log(`Derived account index: ${accountIndex}`);
    log(`Owner p2tr: ${wallet.p2tr}`);
    log(`Expected:   opt1ps7vxl0vfcrl8uwvwrqntaqlvsmy5rr7ayug3luncwu38dt7ynfcssfhr2k`);
    if (wallet.p2tr !== 'opt1ps7vxl0vfcrl8uwvwrqntaqlvsmy5rr7ayug3luncwu38dt7ynfcssfhr2k') {
        console.error('\n[WARN] Address mismatch! Wrong mnemonic or wrong ACCOUNT_INDEX.');
        console.error('Try ACCOUNT_INDEX=0 or check your seed phrase.\n');
        process.exit(1);
    }
    log('✓ Address verified!');
    log(`Executor: ${EXECUTOR_ADDR}`);
    log(`FeeVest:  ${FEEVEST_ADDR}`);
    log(`FeeToken: ${FEETOKEN_ADDR}`);
    log('');

    // Normalize ABI: SDK expects lowercase "type" field ("function" not "Function")
    const abi = ABI.functions.map(f => ({ ...f, type: f.type.toLowerCase() }));

    const executor = getContract(
        Address.fromString(EXECUTOR_ADDR),
        abi,
        provider,
        NETWORK,
        wallet.address,
    );

    // ── 1. initialize ─────────────────────────────────────────────────────────
    log('── Step 1: initialize(publicVesting) ────────────────────────');
    const sim1 = await executor.initialize(Address.fromString(FEEVEST_ADDR));
    await sendTx(sim1, wallet, 'initialize(FeeVest)');
    log('');
    await sleep(15_000);

    // ── 2. setRiskParams ─────────────────────────────────────────────────────
    log('── Step 2: setRiskParams ────────────────────────────────────');
    const sim2 = await executor.setRiskParams(MAX_AMOUNT_PER_TX, GLOBAL_MIN_BLOCKS_GAP);
    await sendTx(sim2, wallet, 'setRiskParams(1M FEE, gap=5)');
    log('');
    await sleep(15_000);

    // ── 3. setAllowedToken ────────────────────────────────────────────────────
    log('── Step 3: setAllowedToken(feeToken, 1) ─────────────────────');
    const sim3 = await executor.setAllowedToken(Address.fromString(FEETOKEN_ADDR), 1n);
    await sendTx(sim3, wallet, 'setAllowedToken(FeeToken, 1)');
    log('');

    log('══════════════════════════════════════════════════════');
    log('✓ Executor fully initialized and ready!');
}

main().catch(err => {
    console.error('\n[ERROR]', err?.message ?? err);
    process.exit(1);
});
