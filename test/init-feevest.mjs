/**
 * FeeVest — Post-Deploy Initialization Script (plain ESM JS)
 *
 * Calls initialize(FeeToken) on the newly deployed FeeVest contract.
 * Must be called once by the owner right after deployment.
 *
 * Usage (PowerShell):
 *   $env:OWNER_MNEMONIC="word1 word2 ... word12"
 *   $env:ACCOUNT_INDEX="1"
 *   node test/init-feevest.mjs
 */

import { getContract, JSONRpcProvider } from 'opnet';
import { Address, AddressTypes, MLDSASecurityLevel, Mnemonic } from '@btc-vision/transaction';
import { networks } from '@btc-vision/bitcoin';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ABI = require('../abis/FeeVest.abi.json');

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const NETWORK   = networks.opnetTestnet;
const RPC_URL   = 'https://testnet.opnet.org';

const FEEVEST_ADDR  = '0x83d8c452bdaf0b13ca1e8867a1f0dd67840609601da994d43c67abb3482f24a2';
const FEETOKEN_ADDR = '0xdbe1fd1a52d80579d7f1ac7bac951b38084668944168689c3a011a482ccc9793';

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

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
    const phrase = process.env.OWNER_MNEMONIC ?? '';
    if (!phrase) {
        console.error('\n[ERROR] OWNER_MNEMONIC is not set.\n');
        process.exit(1);
    }

    const accountIndex = parseInt(process.env.ACCOUNT_INDEX ?? '1', 10);
    const mnemonic = new Mnemonic(phrase, '', NETWORK, MLDSASecurityLevel.LEVEL2);
    const wallet   = mnemonic.deriveOPWallet(AddressTypes.P2TR, accountIndex);

    const provider = new JSONRpcProvider({ url: RPC_URL, network: NETWORK });

    log(`Derived account index: ${accountIndex}`);
    log(`Owner p2tr: ${wallet.p2tr}`);
    log(`Expected:   opt1ps7vxl0vfcrl8uwvwrqntaqlvsmy5rr7ayug3luncwu38dt7ynfcssfhr2k`);
    if (wallet.p2tr !== 'opt1ps7vxl0vfcrl8uwvwrqntaqlvsmy5rr7ayug3luncwu38dt7ynfcssfhr2k') {
        console.error('\n[WARN] Address mismatch! Wrong mnemonic or wrong ACCOUNT_INDEX.');
        process.exit(1);
    }
    log('✓ Address verified!');
    log(`FeeVest:  ${FEEVEST_ADDR}`);
    log(`FeeToken: ${FEETOKEN_ADDR}`);
    log('');

    const abi = ABI.functions.map(f => ({ ...f, type: f.type.toLowerCase() }));

    const feevest = getContract(
        Address.fromString(FEEVEST_ADDR),
        abi,
        provider,
        NETWORK,
        wallet.address,
    );

    log('── initialize(FeeToken) ─────────────────────────────────────');
    const sim = await feevest.initialize(Address.fromString(FEETOKEN_ADDR));
    await sendTx(sim, wallet, 'initialize(FeeToken)');
    log('');
    log('✓ FeeVest initialized! Ready to accept depositAndVest().');
}

main().catch(err => {
    console.error('\n[ERROR]', err?.message ?? err);
    process.exit(1);
});
