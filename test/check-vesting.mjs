/**
 * Проверка состояния вестинга после depositAndVest.
 * Также выводит реальный hex wallet.address для сравнения с tweakedPubkey.
 */

import { getContract, JSONRpcProvider, OP_20_ABI } from 'opnet';
import { Address, AddressTypes, MLDSASecurityLevel, Mnemonic } from '@btc-vision/transaction';
import { networks } from '@btc-vision/bitcoin';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const FEEVEST_ABI_JSON = require('../abis/FeeVest.abi.json');

const NETWORK     = networks.opnetTestnet;
const RPC_URL     = 'https://testnet.opnet.org';
const FEEVEST_ADDR  = '0x83d8c452bdaf0b13ca1e8867a1f0dd67840609601da994d43c67abb3482f24a2';
const FEETOKEN_ADDR = '0xdbe1fd1a52d80579d7f1ac7bac951b38084668944168689c3a011a482ccc9793';

// from-поле транзакции depositAndVest (Blockchain.tx.sender внутри контракта)
const FROM_TX = '0x7ac634415179904ec71de5df';  // неполный — уточним скриптом

function normalizeAbi(abi) {
    return abi.map(f => ({ ...f, type: f.type.toLowerCase() }));
}
function fmt(hex) { return hex?.length > 16 ? hex.slice(0, 10) + '...' + hex.slice(-6) : hex; }

async function main() {
    const phrase = process.env.OWNER_MNEMONIC ?? '';
    if (!phrase) { console.error('[ERROR] Set $env:OWNER_MNEMONIC'); process.exit(1); }

    const accountIndex = parseInt(process.env.ACCOUNT_INDEX ?? '1', 10);
    const mnemonic = new Mnemonic(phrase, '', NETWORK, MLDSASecurityLevel.LEVEL2);
    const wallet   = mnemonic.deriveOPWallet(AddressTypes.P2TR, accountIndex);

    console.log('\n══ Диагностика адресов ══════════════════════════════════');
    console.log('wallet.p2tr    :', wallet.p2tr);

    // wallet.address — это то, что контракт видит как Blockchain.tx.sender
    const walletAddrHex = wallet.address.toHex?.() ?? Buffer.from(wallet.address).toString('hex');
    console.log('wallet.address :', walletAddrHex);
    console.log('tweakedPubkey  : 0x87986fbd89c0fe7e398e1826be83ec86c9418fdd27111ff278772276afc49a71');
    console.log('from (tx)      : 7ac634415179904ec71de5dfed7bc5b855657914350799068b69b60f10383426');
    console.log('Совпадает?     :', walletAddrHex === '0x87986fbd89c0fe7e398e1826be83ec86c9418fdd27111ff278772276afc49a71' ? 'tweakedPubkey' : 'другой адрес');
    console.log('');

    const provider = new JSONRpcProvider({ url: RPC_URL, network: NETWORK });
    const feeVestAbi = normalizeAbi(FEEVEST_ABI_JSON.functions);

    // Запрашиваем getVesting с wallet.address (как в test-flow)
    console.log('══ getVesting(wallet.address) ══════════════════════════');
    const r1 = await getContract(
        Address.fromString(FEEVEST_ADDR), feeVestAbi, provider, NETWORK, Address.dead()
    ).getVesting(wallet.address);
    console.log('totalAmount:', (r1?.properties?.totalAmount ?? 0n) / 10n**18n, 'REV');
    console.log('raw        :', JSON.stringify(r1?.properties ?? r1));
    console.log('');

    // Если ноль — пробуем с tweakedPubkey
    if ((r1?.properties?.totalAmount ?? 0n) === 0n) {
        console.log('══ getVesting(tweakedPubkey) ═══════════════════════════');
        const tpAddr = Address.fromString('0x87986fbd89c0fe7e398e1826be83ec86c9418fdd27111ff278772276afc49a71');
        const r2 = await getContract(
            Address.fromString(FEEVEST_ADDR), feeVestAbi, provider, NETWORK, Address.dead()
        ).getVesting(tpAddr);
        console.log('totalAmount:', (r2?.properties?.totalAmount ?? 0n) / 10n**18n, 'REV');
        console.log('raw        :', JSON.stringify(r2?.properties ?? r2));
        console.log('');
    }

    // totalLocked глобально
    console.log('══ totalLocked() ═══════════════════════════════════════');
    const tl = await getContract(
        Address.fromString(FEEVEST_ADDR), feeVestAbi, provider, NETWORK, Address.dead()
    ).totalLocked();
    console.log('totalLocked:', (tl?.properties?.amount ?? 0n) / 10n**18n, 'REV');

    // totalRevenueDeposited
    const tr = await getContract(
        Address.fromString(FEEVEST_ADDR), feeVestAbi, provider, NETWORK, Address.dead()
    ).totalRevenueDeposited();
    console.log('totalRevenue:', (tr?.properties?.amount ?? 0n) / 10n**18n, 'REV');
    console.log('');
}

main().catch(err => { console.error('\n[ERROR]', err?.message ?? err); process.exit(1); });
