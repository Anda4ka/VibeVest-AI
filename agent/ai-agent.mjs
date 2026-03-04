/**
 * VibeVest AI Agent
 *
 * Читает состояние вестинга с OPNet testnet, спрашивает Gemini через
 * OpenRouter — стоит ли release() или claimRevenue() — и исполняет on-chain.
 *
 * Модель: google/gemini-3-flash-preview (OpenRouter)
 *
 * Usage (PowerShell):
 *   $env:OWNER_MNEMONIC="word1 ... word12"
 *   $env:ACCOUNT_INDEX="1"
 *   $env:OPENROUTER_API_KEY="sk-or-v1-..."
 *   node agent/ai-agent.mjs
 *
 * Optional env vars:
 *   AI_MODEL        — OpenRouter model ID (default: google/gemini-3-flash-preview)
 *   POLL_INTERVAL   — seconds between checks (default: 30)
 *   DRY_RUN=1       — print AI decision but don't send tx
 */

import { CallResult, getContract, JSONRpcProvider } from 'opnet';
import { Address, AddressTypes, MLDSASecurityLevel, Mnemonic } from '@btc-vision/transaction';
import { networks } from '@btc-vision/bitcoin';
import { createRequire } from 'module';
import http from 'http';

const require = createRequire(import.meta.url);
const FEEVEST_ABI_JSON = require('../abis/FeeVest.abi.json');

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const NETWORK       = networks.opnetTestnet;
const RPC_URL       = 'https://testnet.opnet.org';
const FEEVEST_ADDR  = '0x83d8c452bdaf0b13ca1e8867a1f0dd67840609601da994d43c67abb3482f24a2';
const FEEVEST_P2OP  = 'opt1sqqcgjuyshp4x4p4epuve9th60sxg6t3zhczv5ntm';

const AI_MODEL      = process.env.AI_MODEL ?? 'google/gemini-3-flash-preview';
const POLL_SEC      = parseInt(process.env.POLL_INTERVAL ?? '30', 10);
const DRY_RUN       = process.env.DRY_RUN === '1';
const HTTP_PORT     = parseInt(process.env.PORT ?? '3000', 10);

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

// ─── In-memory log store (shown on website) ──────────────────────────────────
const agentLog = [];   // max 50 entries
let agentStatus = { running: false, cycle: 0, lastBlock: 0, startedAt: new Date().toISOString() };

function pushLog(entry) {
    agentLog.unshift(entry);           // newest first
    if (agentLog.length > 50) agentLog.pop();
}

// ─── HTTP server (health + public log API) ───────────────────────────────────
function startHttpServer() {
    const server = http.createServer((req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', 'application/json');

        if (req.url === '/health') {
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true, ...agentStatus }));
        } else if (req.url === '/api/log') {
            res.writeHead(200);
            res.end(JSON.stringify({ status: agentStatus, log: agentLog }));
        } else {
            res.writeHead(404);
            res.end(JSON.stringify({ error: 'not found' }));
        }
    });
    server.listen(HTTP_PORT, () => log(`HTTP server → http://localhost:${HTTP_PORT}`));
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function log(msg)  { console.log(`[${ts()}] ${msg}`); }
function warn(msg) { console.warn(`[${ts()}] ⚠ ${msg}`); }
function ts()      { return new Date().toISOString().slice(11, 19); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function normalizeAbi(abi) { return abi.map(f => ({ ...f, type: f.type.toLowerCase() })); }
function fmt18(v)  { return (BigInt(v ?? 0) / 10n ** 18n).toString(); }

// ─── Send tx without simulation (cross-contract calls → OOM) ─────────────────
async function sendTxDirect(contract, functionName, args, wallet, provider, label) {
    log(`  [tx] encoding ${label}…`);
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
    log(`  ✓ ${label} → ${txId}`);
    return txId;
}

// ─── Read chain state ─────────────────────────────────────────────────────────
async function readState(provider, feeVestAbi, walletAddr) {
    const view = getContract(
        Address.fromString(FEEVEST_ADDR), feeVestAbi, provider, NETWORK, Address.dead()
    );

    const [vestingRes, claimableRes, blockRes] = await Promise.all([
        view.getVesting(walletAddr),
        view.getClaimableRevenue(walletAddr),
        provider.getBlockNumber(),
    ]);

    const p = vestingRes?.properties ?? {};
    return {
        blockNumber:     Number(blockRes ?? 0),
        totalAmount:     BigInt(p.totalAmount    ?? 0),
        startBlock:      BigInt(p.startBlock     ?? 0),
        cliffDuration:   BigInt(p.cliffDuration  ?? 0),
        vestingDuration: BigInt(p.vestingDuration ?? 0),
        released:        BigInt(p.released       ?? 0),
        releasable:      BigInt(p.releasable      ?? 0),
        claimable:       BigInt(claimableRes?.properties?.amount ?? 0),
    };
}

// ─── Ask Gemini via OpenRouter ────────────────────────────────────────────────
async function askAI(apiKey, state, history) {
    const {
        blockNumber, totalAmount, startBlock, cliffDuration,
        vestingDuration, released, releasable, claimable,
    } = state;

    const cliffEnd   = startBlock + cliffDuration;
    const vestEnd    = startBlock + vestingDuration;
    const blocksLeft = vestEnd > BigInt(blockNumber) ? vestEnd - BigInt(blockNumber) : 0n;
    const pctVested  = totalAmount > 0n
        ? Number((released + releasable) * 100n / totalAmount)
        : 0;

    const prompt = `You are a DeFi portfolio manager for a Bitcoin L1 vesting protocol (OPNet).

## Current Vesting State (block #${blockNumber})
- Total locked:       ${fmt18(totalAmount)} REV
- Start block:        ${startBlock}
- Cliff ends:         block ${cliffEnd} (${blockNumber >= Number(cliffEnd) ? 'PASSED ✓' : `${Number(cliffEnd) - blockNumber} blocks away`})
- Vesting ends:       block ${vestEnd} (${blocksLeft} blocks remaining)
- Already released:   ${fmt18(released)} REV
- Releasable NOW:     ${fmt18(releasable)} REV
- Claimable revenue:  ${fmt18(claimable)} REV
- Vested so far:      ~${pctVested}% of total

## Recent actions (last 5):
${history.length === 0 ? '  (none yet)' : history.slice(-5).map(h => `  ${h}`).join('\n')}

## Available actions
1. "release"        — release ${fmt18(releasable)} REV tokens to wallet (only if releasable > 0)
2. "claim_revenue"  — claim ${fmt18(claimable)} REV protocol revenue (only if claimable > 0)
3. "both"           — do release AND claim_revenue (if both > 0)
4. "wait"           — do nothing this cycle

## Instructions
- Prioritise claiming if claimable > 10 REV (gas cost ~1500 sat, negligible)
- Release if releasable > 50 REV (not worth releasing dust amounts)
- Never suggest an action if the amount is 0
- Be concise in your reasoning (1-2 sentences max)

Respond ONLY with valid JSON (no markdown, no code block):
{"action":"release|claim_revenue|both|wait","reason":"...","confidence":0.0-1.0}`;

    const response = await fetch(OPENROUTER_URL, {
        method:  'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type':  'application/json',
            'HTTP-Referer':  'https://vibe-vest-ai.vercel.app',
            'X-Title':       'VibeVest AI Agent',
        },
        body: JSON.stringify({
            model:    AI_MODEL,
            messages: [{ role: 'user', content: prompt }],
            response_format: { type: 'json_object' },
            temperature: 0.2,
            max_tokens:  200,
        }),
    });

    if (!response.ok) {
        const err = await response.text();
        throw new Error(`OpenRouter error ${response.status}: ${err}`);
    }

    const data    = await response.json();
    const content = data.choices?.[0]?.message?.content ?? '{}';

    try {
        return JSON.parse(content);
    } catch {
        warn(`AI returned non-JSON: ${content}`);
        return { action: 'wait', reason: 'parse error', confidence: 0 };
    }
}

// ─── Execute AI decision ──────────────────────────────────────────────────────
async function execute(decision, vault, wallet, provider) {
    const { action, reason } = decision;

    if (action === 'release' || action === 'both') {
        log(`  → release(): ${reason}`);
        if (!DRY_RUN) {
            await sendTxDirect(vault, 'release', [], wallet, provider, 'release()');
            await sleep(15_000);
        } else {
            log('  [DRY_RUN] skipped tx');
        }
    }

    if (action === 'claim_revenue' || action === 'both') {
        log(`  → claimRevenue(): ${reason}`);
        if (!DRY_RUN) {
            await sendTxDirect(vault, 'claimRevenue', [], wallet, provider, 'claimRevenue()');
            await sleep(15_000);
        } else {
            log('  [DRY_RUN] skipped tx');
        }
    }

    if (action === 'wait') {
        log(`  → wait: ${reason}`);
    }
}

// ─── Main loop ────────────────────────────────────────────────────────────────
async function main() {
    const phrase   = process.env.OWNER_MNEMONIC ?? '';
    const apiKey   = process.env.OPENROUTER_API_KEY ?? '';

    if (!phrase)  { console.error('[ERROR] Set $env:OWNER_MNEMONIC');     process.exit(1); }
    if (!apiKey)  { console.error('[ERROR] Set $env:OPENROUTER_API_KEY'); process.exit(1); }

    const accountIndex = parseInt(process.env.ACCOUNT_INDEX ?? '1', 10);
    const mnemonic     = new Mnemonic(phrase, '', NETWORK, MLDSASecurityLevel.LEVEL2);
    const wallet       = mnemonic.deriveOPWallet(AddressTypes.P2TR, accountIndex);
    const provider     = new JSONRpcProvider({ url: RPC_URL, network: NETWORK });
    const feeVestAbi   = normalizeAbi(FEEVEST_ABI_JSON.functions);

    const vault = getContract(
        Address.fromString(FEEVEST_ADDR), feeVestAbi, provider, NETWORK, wallet.address
    );

    log('══════════════════════════════════════════════');
    log('  VibeVest AI Agent');
    log(`  Model:    ${AI_MODEL}`);
    log(`  Wallet:   ${wallet.p2tr}`);
    log(`  FeeVest:  ${FEEVEST_ADDR}`);
    log(`  Interval: ${POLL_SEC}s`);
    if (DRY_RUN) log('  ⚠ DRY_RUN mode — txs will NOT be sent');
    log('══════════════════════════════════════════════');
    log('');

    startHttpServer();

    const history = [];
    let cycle = 0;
    agentStatus.running = true;

    // eslint-disable-next-line no-constant-condition
    while (true) {
        cycle++;
        log(`── Cycle #${cycle} ──────────────────────────────────`);

        try {
            // 1. Read chain state
            log('Reading chain state…');
            const state = await readState(provider, feeVestAbi, wallet.address);
            agentStatus.lastBlock = state.blockNumber;
            agentStatus.cycle = cycle;

            log(`  block:     #${state.blockNumber}`);
            log(`  releasable: ${fmt18(state.releasable)} REV`);
            log(`  claimable:  ${fmt18(state.claimable)} REV`);

            if (state.totalAmount === 0n) {
                log('  No active vesting schedule. Waiting…');
                pushLog({
                    time: new Date().toISOString(), cycle,
                    block: state.blockNumber,
                    action: 'wait', confidence: 1,
                    reason: 'No active vesting schedule.',
                    releasable: '0', claimable: '0', txId: null,
                });
                await sleep(POLL_SEC * 1000);
                continue;
            }

            // 2. Ask AI
            log(`Asking ${AI_MODEL}…`);
            const decision = await askAI(apiKey, state, history);

            const confidence = ((decision.confidence ?? 0) * 100).toFixed(0);
            log(`  AI decision: "${decision.action}" (${confidence}% confidence)`);
            log(`  Reason: ${decision.reason}`);

            // 3. Execute
            await execute(decision, vault, wallet, provider);

            // 4. Record history + push to public log
            const entry = `[block ${state.blockNumber}] ${decision.action}: ${decision.reason}`;
            history.push(entry);
            if (history.length > 20) history.shift();

            pushLog({
                time:       new Date().toISOString(),
                cycle,
                block:      state.blockNumber,
                action:     decision.action,
                confidence: decision.confidence ?? 0,
                reason:     decision.reason,
                releasable: fmt18(state.releasable),
                claimable:  fmt18(state.claimable),
                dryRun:     DRY_RUN,
            });

        } catch (err) {
            warn(`Cycle error: ${err?.message ?? err}`);
            pushLog({
                time: new Date().toISOString(), cycle,
                block: agentStatus.lastBlock,
                action: 'error', confidence: 0,
                reason: err?.message ?? String(err),
                releasable: '?', claimable: '?',
            });
        }

        log('');
        log(`Next check in ${POLL_SEC}s…`);
        await sleep(POLL_SEC * 1000);
    }
}

main().catch(err => { console.error('\n[ERROR]', err?.message ?? err); process.exit(1); });
