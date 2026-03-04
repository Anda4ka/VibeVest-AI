# VibeVest AI — AI-Powered Fee-to-Vesting on Bitcoin L1

> **VibeCoding Week 3** · OPNet Testnet · Gemini 3 Flash · Railway · Vercel

A permissionless fee-to-vesting protocol on Bitcoin L1 (OPNet) with a **live AI agent** that autonomously manages vesting positions using Google Gemini 3 Flash.

**🌐 Live:** https://vibe-vest-ai.vercel.app/
**🤖 AI Agent API:** https://vibevest-ai-production.up.railway.app/api/log
**📦 GitHub:** https://github.com/Anda4ka/VibeVest-AI

---

## What It Does

1. **Anyone** can lock OP_20 tokens for any beneficiary in one transaction (`depositAndVest`)
2. **Anyone** can deposit protocol revenue for proportional distribution (`depositRevenue`)
3. A **live Gemini 3 Flash AI agent** polls the chain every 30 seconds and autonomously decides when to call `release()` or `claimRevenue()` — then executes the transaction on-chain
4. All AI decisions are streamed live to the website — visitors see Gemini's reasoning in real time

---

## Deployed Contracts (OPNet Testnet)

| Contract | Address |
|----------|---------|
| **FeeVest v2** (main) | `0x83d8c452bdaf0b13ca1e8867a1f0dd67840609601da994d43c67abb3482f24a2` |
| **FeeToken (REV)** | `0xdbe1fd1a52d80579d7f1ac7bac951b38084668944168689c3a011a482ccc9793` |
| **VibeVestAIExecutor** | `0xeb7f4c354717a568d12b491d7ff2ad957ea36f7ba7d52941d06bef646badf546` |

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    OPNet Bitcoin L1                     │
│                                                         │
│  FeeVest v2 ←──────── VibeVestAIExecutor               │
│  (vesting + revenue)   (intent automation)              │
└────────────────────────┬────────────────────────────────┘
                         │ JSON-RPC reads (every 30s)
                         ▼
              ┌──────────────────────┐
              │   AI Agent (Railway) │
              │   Node.js 20         │
              │   ↕ OpenRouter API   │
              │   Gemini 3 Flash     │
              │   → decision JSON    │
              │   → sendTx on-chain  │
              └──────────┬───────────┘
                         │ /api/log (CORS open)
                         ▼
              ┌──────────────────────┐
              │  Website (Vercel)    │
              │  Live Decision Feed  │
              │  polls every 30s     │
              └──────────────────────┘
```

### Smart Contract — FeeVest v2

| Method | Access | Description |
|--------|--------|-------------|
| `depositAndVest(amount, beneficiary, cliff, duration)` | Public | Lock tokens, create vesting schedule |
| `depositRevenue(amount)` | Public | Deposit revenue for proportional distribution |
| `release()` | Beneficiary | Release vested tokens after cliff |
| `claimRevenue()` | Beneficiary | Claim accumulated revenue share |
| `getVesting(address)` | View | Full vesting schedule |
| `getClaimableRevenue(address)` | View | Claimable revenue amount |
| `totalLocked()` | View | Total tokens locked |

**Key properties:**
- Synthetix O(1) reward-per-token accumulator — no iteration over holder lists
- `StoredBoolean` reentrancy guard (persists across cross-contract calls)
- Strict CEI (Checks-Effects-Interactions) on every state-changing method
- No owner gatekeeping — fully permissionless

### AI Agent — Gemini 3 Flash

The agent runs as a Node.js worker on Railway and:

1. **Reads chain state** via OPNet JSON-RPC: `getVesting`, `getClaimableRevenue`, block number
2. **Asks Gemini 3 Flash** (via OpenRouter) with a structured prompt including releasable/claimable amounts, vesting %, cliff status, and action history
3. **Receives JSON decision**: `{ action: "release|claim_revenue|both|wait", reason: "...", confidence: 0.0-1.0 }`
4. **Executes on-chain** using `sendTxDirect` pattern (bypasses simulation OOM for cross-contract calls)
5. **Exposes `/api/log`** endpoint — last 50 decisions served as JSON for the live website feed

**AI decision rules (in the prompt):**
- Release if `releasable > 50 REV`
- Claim if `claimable > 10 REV`
- Never act when amount is 0

### Intent Executor — VibeVestAIExecutor

Users sign typed intents off-chain; any relayer submits them on-chain.

| Feature | Status |
|---------|--------|
| DEPOSIT_AND_VEST via signed intent | ✅ Fully working |
| Schnorr BIP-340 + keccak256 domain separation | ✅ Verified on-chain |
| Sequential nonce replay protection | ✅ Enforced per-user |
| Block deadline expiry | ✅ Enforced |
| Owner risk guards (maxAmountPerTx, allowedToken, gap) | ✅ Configurable |
| Per-user throttle | ✅ Enforced |

---

## CEI Flow

```
depositAndVest()
  ├─ CHECKS:  validate inputs, verify no existing schedule
  ├─ EFFECTS: updateReward snapshot, write schedule, increase totalLocked
  └─ INTERACT: transferFrom(depositor → vault)

release()
  ├─ CHECKS:  has schedule, releasable > 0
  ├─ EFFECTS: updateReward, mark released, decrease totalLocked
  └─ INTERACT: transfer(vault → beneficiary)

claimRevenue()
  ├─ CHECKS:  has schedule
  ├─ EFFECTS: updateReward, zero pendingRewards
  └─ INTERACT: transfer(vault → beneficiary)
```

---

## Running the AI Agent Locally

```bash
npm install

# Required env vars
$env:OWNER_MNEMONIC="word1 word2 ... word12"
$env:OPENROUTER_API_KEY="sk-or-v1-..."

# Optional
$env:ACCOUNT_INDEX="1"          # wallet derivation index (default: 1)
$env:POLL_INTERVAL="30"         # seconds between checks (default: 30)
$env:DRY_RUN="1"                # print decisions, don't send txs
$env:PORT="3000"                # HTTP server port (default: 3000)

node agent/ai-agent.mjs
```

**HTTP endpoints:**
- `GET /health` — agent status (running, cycle, lastBlock)
- `GET /api/log` — last 50 AI decisions as JSON

---

## Building the Smart Contract

```bash
npm install
npm run build          # debug  → build/feevest.debug.wasm
npm run build:release  # release → build/feevest.release.wasm
npm run build:executor:release  # executor → build/executor.release.wasm
```

---

## Security

- Audit: 0 critical — Bob MCP + manual review
- `StoredBoolean` reentrancy guard (persistent storage, not a class field)
- No `tx.origin` — only `Blockchain.tx.sender`
- All u256 arithmetic via `SafeMath`
- O(1) everywhere — no unbounded loops
- One active schedule per beneficiary (griefing mitigation)

---

## Tech Stack

| Layer | Tech |
|-------|------|
| Smart contracts | AssemblyScript → WASM (OPNet btc-runtime) |
| On-chain execution | OPNet / @btc-vision SDK |
| AI model | Google Gemini 3 Flash (via OpenRouter) |
| AI agent hosting | Railway (Node.js 20 worker) |
| Frontend | Vanilla HTML/CSS/JS (Vercel) |
| Bitcoin network | OPNet Testnet (Bitcoin Signet fork) |

---

## License

MIT
