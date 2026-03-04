/**
 * VibeVestAIExecutor — Post-Deploy Initialization Script
 *
 * Calls 3 owner-only methods in sequence:
 *   1. initialize(publicVesting)
 *   2. setRiskParams(maxAmountPerTx, globalMinBlocksGap)
 *   3. setAllowedToken(feeToken, 1)
 *
 * Usage (set your seed phrase in env):
 *   OWNER_MNEMONIC="word1 word2 ... word12" node --loader ts-node/esm test/init-executor.ts
 *
 * Or install ts-node first:
 *   npm install -D ts-node typescript
 */

import { getContract, JSONRpcProvider, TransactionParameters } from 'opnet';
import { Address, AddressTypes, MLDSASecurityLevel, Mnemonic, Wallet } from '@btc-vision/transaction';
import { Network, networks } from '@btc-vision/bitcoin';
import { VibeVestAIExecutorAbi } from '../abis/VibeVestAIExecutor.abi.js';

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const NETWORK: Network  = networks.opnetTestnet;
const RPC_URL           = 'https://testnet.opnet.org';

// Deployed contract addresses (SDK hex = tweakedPubkey)
const EXECUTOR_ADDR  = '0xeb7f4c354717a568d12b491d7ff2ad957ea36f7ba7d52941d06bef646badf546';
const FEEVEST_ADDR   = '0x813078152d97d3181b8e52f64f24451aed1916b7d6c459c5146b098045080089';
const FEETOKEN_ADDR  = '0xdbe1fd1a52d80579d7f1ac7bac951b38084668944168689c3a011a482ccc9793';

// Risk parameters
const MAX_AMOUNT_PER_TX     = 1_000_000n * 10n ** 18n; // 1M FEE tokens
const GLOBAL_MIN_BLOCKS_GAP = 5n;                       // 5 blocks between executions

// Transaction fees
const TX_PARAMS_BASE = {
    maximumAllowedSatToSpend: 100_000n, // 0.001 BTC max fee
    feeRate: 10,
    network: NETWORK,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
function log(msg: string): void {
    console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

async function sendTx(
    simulation: any,
    wallet: Wallet,
    label: string,
): Promise<void> {
    log(`Sending ${label}…`);
    const params: TransactionParameters = {
        ...TX_PARAMS_BASE,
        signer: wallet.keypair,
        mldsaSigner: wallet.mldsaKeypair,
        refundTo: wallet.p2tr,
    };
    const receipt = await simulation.sendTransaction(params);
    log(`✓ ${label} txId: ${receipt?.transactionId ?? 'confirmed'}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
    const mnemonicPhrase = process.env.OWNER_MNEMONIC ?? '';
    if (!mnemonicPhrase) {
        console.error(
            '\n[ERROR] Set OWNER_MNEMONIC environment variable.\n' +
            'Export your seed phrase from OP_NET wallet Settings → Security → Export Mnemonic.\n\n' +
            'Windows PowerShell:\n' +
            '  $env:OWNER_MNEMONIC="word1 word2 ... word12"\n' +
            '  node --loader ts-node/esm test/init-executor.ts\n',
        );
        process.exit(1);
    }

    // Derive wallet — same derivation path as OP_NET wallet (P2TR, index 0)
    const mnemonic = new Mnemonic(mnemonicPhrase, '', NETWORK, MLDSASecurityLevel.LEVEL2);
    const wallet: Wallet = mnemonic.deriveUnisat(AddressTypes.P2TR, 0);

    const provider = new JSONRpcProvider({ url: RPC_URL, network: NETWORK });

    log(`Owner:    ${wallet.address}`);
    log(`Executor: ${EXECUTOR_ADDR}`);
    log(`FeeVest:  ${FEEVEST_ADDR}`);
    log(`FeeToken: ${FEETOKEN_ADDR}`);
    log('');

    const executor = getContract(
        Address.fromString(EXECUTOR_ADDR),
        VibeVestAIExecutorAbi,
        provider,
        NETWORK,
        wallet.address,
    );

    // ── 1. initialize ─────────────────────────────────────────────────────────
    log('── Step 1: initialize(publicVesting) ────────────────────────');
    const sim1 = await (executor as any).initialize(Address.fromString(FEEVEST_ADDR));
    await sendTx(sim1, wallet, 'initialize(FeeVest)');
    log('');

    log('Waiting 15s before next tx…');
    await new Promise(r => setTimeout(r, 15_000));

    // ── 2. setRiskParams ─────────────────────────────────────────────────────
    log('── Step 2: setRiskParams ────────────────────────────────────');
    const sim2 = await (executor as any).setRiskParams(MAX_AMOUNT_PER_TX, GLOBAL_MIN_BLOCKS_GAP);
    await sendTx(sim2, wallet, `setRiskParams(1M FEE, gap=5)`);
    log('');

    await new Promise(r => setTimeout(r, 15_000));

    // ── 3. setAllowedToken ────────────────────────────────────────────────────
    log('── Step 3: setAllowedToken(feeToken, 1) ─────────────────────');
    const sim3 = await (executor as any).setAllowedToken(Address.fromString(FEETOKEN_ADDR), 1n);
    await sendTx(sim3, wallet, 'setAllowedToken(FeeToken, 1)');
    log('');

    log('═══════════════════════════════════════════════════════════');
    log('✓ Executor fully initialized!');
    log('Ready to accept intents via executeIntent()');
}

main().catch(err => {
    console.error('\n[ERROR]', err.message ?? err);
    process.exit(1);
});
