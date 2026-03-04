/**
 * FeeVest — Release + ClaimRevenue
 *
 * Вызывает release() и claimRevenue() после прохождения клиффа.
 * Вестинг: startBlock=3858, cliff=5 → доступно после блока 3863.
 *
 * ВАЖНО: release() и claimRevenue() внутри делают transferFrom/transfer
 * → симуляция падает с OOM → используем sendTxDirect.
 *
 * Usage:
 *   $env:OWNER_MNEMONIC="word1 ... word12"
 *   $env:ACCOUNT_INDEX="1"
 *   node test/test-release.mjs
 */

import { CallResult, getContract, JSONRpcProvider } from 'opnet';
import { Address, AddressTypes, MLDSASecurityLevel, Mnemonic } from '@btc-vision/transaction';
import { networks } from '@btc-vision/bitcoin';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const FEEVEST_ABI_JSON = require('../abis/FeeVest.abi.json');

const NETWORK     = networks.opnetTestnet;
const RPC_URL     = 'https://testnet.opnet.org';
const FEEVEST_ADDR  = '0x83d8c452bdaf0b13ca1e8867a1f0dd67840609601da994d43c67abb3482f24a2';
const FEEVEST_P2OP  = 'opt1sqqcgjuyshp4x4p4epuve9th60sxg6t3zhczv5ntm';

function log(msg) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function normalizeAbi(abi) { return abi.map(f => ({ ...f, type: f.type.toLowerCase() })); }

/**
 * Отправить транзакцию без симуляции (для методов с cross-contract вызовами).
 */
async function sendTxDirect(contract, functionName, args, wallet, provider, label) {
    log(`  [direct] ${label}…`);
    const calldata = contract.encodeCalldata(functionName, args);
    const contractAddress = typeof contract.address === 'string'
        ? Address.fromString(contract.address)
        : contract.address;

    const fakeResult = new CallResult(
        { result: new Uint8Array(1), accessList: {}, events: {}, revert: undefined,
          estimatedGas: '50000', specialGas: '0' },
        provider,
    );
    fakeResult.setCalldata(calldata);
    fakeResult.setTo(FEEVEST_P2OP, contractAddress);
    fakeResult.setGasEstimation(5000n, 0n);

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

async function main() {
    const phrase = process.env.OWNER_MNEMONIC ?? '';
    if (!phrase) { console.error('[ERROR] Set $env:OWNER_MNEMONIC'); process.exit(1); }

    const accountIndex = parseInt(process.env.ACCOUNT_INDEX ?? '1', 10);
    const mnemonic = new Mnemonic(phrase, '', NETWORK, MLDSASecurityLevel.LEVEL2);
    const wallet   = mnemonic.deriveOPWallet(AddressTypes.P2TR, accountIndex);

    const provider  = new JSONRpcProvider({ url: RPC_URL, network: NETWORK });
    const feeVestAbi = normalizeAbi(FEEVEST_ABI_JSON.functions);

    log(`Owner: ${wallet.p2tr}`);
    log(`wallet.address: ${wallet.address.toHex?.() ?? '?'}`);
    log('');

    // ── Проверяем текущий блок и releasable ───────────────────────────────────
    log('── Текущее состояние вестинга ──────────────────────────────');
    const vestContract = getContract(
        Address.fromString(FEEVEST_ADDR), feeVestAbi, provider, NETWORK, Address.dead()
    );

    const vesting = await vestContract.getVesting(wallet.address);
    const p = vesting?.properties ?? {};
    log(`  totalAmount : ${BigInt(p.totalAmount ?? 0) / 10n**18n} REV`);
    log(`  startBlock  : ${p.startBlock}`);
    log(`  cliff       : ${p.cliffDuration} blocks`);
    log(`  duration    : ${p.vestingDuration} blocks`);
    log(`  released    : ${BigInt(p.released ?? 0) / 10n**18n} REV`);
    log(`  releasable  : ${BigInt(p.releasable ?? 0) / 10n**18n} REV`);
    log('');

    const releasable = BigInt(p.releasable ?? 0);
    if (releasable === 0n) {
        log('⚠ releasable = 0. Клифф ещё не прошёл.');
        log(`  Вестинг начат в блоке ${p.startBlock}, клифф = ${p.cliffDuration} блоков.`);
        log(`  Дождитесь блока ${BigInt(p.startBlock ?? 0) + BigInt(p.cliffDuration ?? 0) + 1n}.`);
        log('');
        log('Запусти скрипт снова через несколько блоков.');
        return;
    }

    // ── Получаем claimable revenue ────────────────────────────────────────────
    const claimable = await vestContract.getClaimableRevenue(wallet.address);
    log(`── Claimable revenue: ${BigInt(claimable?.properties?.amount ?? 0) / 10n**18n} REV`);
    log('');

    const vault = getContract(
        Address.fromString(FEEVEST_ADDR), feeVestAbi, provider, NETWORK, wallet.address
    );

    // ── release() ─────────────────────────────────────────────────────────────
    log('── Step 1: release() ────────────────────────────────────────');
    await sendTxDirect(vault, 'release', [], wallet, provider, 'release()');
    log('');
    await sleep(15_000);

    // ── claimRevenue() ────────────────────────────────────────────────────────
    log('── Step 2: claimRevenue() ───────────────────────────────────');
    await sendTxDirect(vault, 'claimRevenue', [], wallet, provider, 'claimRevenue()');
    log('');
    await sleep(15_000);

    // ── Финальная проверка ────────────────────────────────────────────────────
    log('── Итоговое состояние ───────────────────────────────────────');
    const finalVesting = await getContract(
        Address.fromString(FEEVEST_ADDR), feeVestAbi, provider, NETWORK, Address.dead()
    ).getVesting(wallet.address);
    const fp = finalVesting?.properties ?? {};
    log(`  released   : ${BigInt(fp.released ?? 0) / 10n**18n} REV`);
    log(`  releasable : ${BigInt(fp.releasable ?? 0) / 10n**18n} REV`);
    log('');
    log('✓ release + claimRevenue выполнены!');
}

main().catch(err => { console.error('\n[ERROR]', err?.message ?? err); process.exit(1); });
