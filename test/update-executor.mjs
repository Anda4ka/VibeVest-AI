/**
 * VibeVestAIExecutor — Update PublicVesting pointer to FeeVest v2
 *
 * Calls setPublicVesting(FeeVest_v2) on the Executor.
 * Must be called by the owner when migrating to a new FeeVest deployment.
 *
 * Usage (PowerShell):
 *   $env:OWNER_MNEMONIC="word1 ... word12"
 *   $env:ACCOUNT_INDEX="1"
 *   node test/update-executor.mjs
 */

import { getContract, JSONRpcProvider } from 'opnet';
import { Address, AddressTypes, MLDSASecurityLevel, Mnemonic } from '@btc-vision/transaction';
import { networks } from '@btc-vision/bitcoin';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const EXECUTOR_ABI_JSON = require('../abis/VibeVestAIExecutor.abi.json');

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const NETWORK       = networks.opnetTestnet;
const RPC_URL       = 'https://testnet.opnet.org';

const EXECUTOR_ADDR = '0xeb7f4c354717a568d12b491d7ff2ad957ea36f7ba7d52941d06bef646badf546';
const FEEVEST_V2    = '0x83d8c452bdaf0b13ca1e8867a1f0dd67840609601da994d43c67abb3482f24a2';

// ─── Helpers ─────────────────────────────────────────────────────────────────
function log(msg) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`); }
function normalizeAbi(abi) { return abi.map(f => ({ ...f, type: f.type.toLowerCase() })); }

async function sendTx(simulation, wallet, label) {
    log(`  → sending ${label}…`);
    const receipt = await simulation.sendTransaction({
        signer:      wallet.keypair,
        mldsaSigner: wallet.mldsaKeypair,
        refundTo:    wallet.p2tr,
        maximumAllowedSatToSpend: 100_000n,
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
    if (!phrase) { console.error('[ERROR] Set $env:OWNER_MNEMONIC'); process.exit(1); }

    const accountIndex = parseInt(process.env.ACCOUNT_INDEX ?? '1', 10);
    const mnemonic = new Mnemonic(phrase, '', NETWORK, MLDSASecurityLevel.LEVEL2);
    const wallet   = mnemonic.deriveOPWallet(AddressTypes.P2TR, accountIndex);

    log(`Owner:      ${wallet.p2tr}`);
    log(`Executor:   ${EXECUTOR_ADDR}`);
    log(`FeeVest v2: ${FEEVEST_V2}`);
    log('');

    const provider    = new JSONRpcProvider({ url: RPC_URL, network: NETWORK });
    const executorAbi = normalizeAbi(EXECUTOR_ABI_JSON.functions);

    // ── Проверяем текущий publicVesting ──────────────────────────────────────
    log('── Текущий publicVesting (до обновления) ────────────────────');
    const viewContract = getContract(
        Address.fromString(EXECUTOR_ADDR), executorAbi, provider, NETWORK, Address.dead()
    );
    const before = await viewContract.getPublicVesting();
    const beforeHex = before?.properties?.publicVesting?.toHex?.()
        ?? JSON.stringify(before?.properties ?? before);
    log(`  getPublicVesting: ${beforeHex}`);

    if (beforeHex.toLowerCase().includes(FEEVEST_V2.slice(2).toLowerCase())) {
        log('');
        log('✓ Executor уже указывает на FeeVest v2 — обновление не требуется.');
        return;
    }
    log('');

    // ── setPublicVesting(FeeVest_v2) ─────────────────────────────────────────
    log('── setPublicVesting(FeeVest v2) ─────────────────────────────');
    const executor = getContract(
        Address.fromString(EXECUTOR_ADDR), executorAbi, provider, NETWORK, wallet.address
    );
    const sim = await executor.setPublicVesting(Address.fromString(FEEVEST_V2));
    await sendTx(sim, wallet, 'setPublicVesting');
    log('');

    // ── Ждём подтверждения ────────────────────────────────────────────────────
    log('Ожидание 20 сек для подтверждения блока…');
    await new Promise(r => setTimeout(r, 20_000));

    // ── Финальная проверка ────────────────────────────────────────────────────
    log('── Итоговый publicVesting (после обновления) ────────────────');
    const after = await getContract(
        Address.fromString(EXECUTOR_ADDR), executorAbi, provider, NETWORK, Address.dead()
    ).getPublicVesting();
    const afterHex = after?.properties?.publicVesting?.toHex?.()
        ?? JSON.stringify(after?.properties ?? after);
    log(`  getPublicVesting: ${afterHex}`);
    log('');
    log('✓ Executor теперь указывает на FeeVest v2!');
}

main().catch(err => { console.error('\n[ERROR]', err?.message ?? err); process.exit(1); });
