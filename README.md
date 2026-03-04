# PublicVesting — Permissionless Fee-to-Vesting on Bitcoin L1

Anyone with OP_20 tokens can create vesting schedules for any beneficiary in one transaction. Revenue from deposited fees is shared proportionally to all locked-token holders via a Synthetix O(1) accumulator — no loops, no owner gatekeeping.

**Live:** https://vibe-vest-ai.vercel.app/

---

## Features

- **`depositAndVest(amount, beneficiary, cliff, duration)`** — fully public, no owner required
- **`depositRevenue(amount)`** — any address can forward protocol fees for proportional distribution
- **`claimRevenue()`** — beneficiaries claim accumulated revenue share
- **`release()`** — beneficiary releases all currently vested tokens after cliff
- Synthetix O(1) reward-per-token accumulator — no iteration over holder lists
- `StoredBoolean` reentrancy guard (persistent storage, survives cross-contract calls)
- Strict CEI (Checks-Effects-Interactions) on every state-changing method
- Single OP_20 token for both vesting and revenue distribution

---

## Contract Methods

| Method | Access | Description |
|---|---|---|
| `initialize(revenueToken)` | Owner, once | Set the OP_20 token address |
| `depositAndVest(amount, beneficiary, cliff, duration)` | Public | Lock tokens, create vesting schedule |
| `release()` | Beneficiary | Release vested tokens |
| `depositRevenue(amount)` | Public | Deposit revenue for proportional distribution |
| `claimRevenue()` | Beneficiary | Claim accumulated revenue share |
| `getVesting(address)` | View | Returns full vesting schedule for address |
| `getPendingRelease(address)` | View | Returns currently releasable amount |
| `getClaimableRevenue(address)` | View | Returns claimable revenue for address |
| `totalLocked()` | View | Total tokens locked across all schedules |
| `totalRevenueDeposited()` | View | Cumulative revenue ever deposited |
| `revenueToken()` | View | Token address |
| `owner()` | View | Contract owner |

---

## Build & Deploy

### Prerequisites

```bash
npm install
```

### Compile

```bash
npm run build          # debug build  →  build/feevest.debug.wasm
npm run build:release  # release build → build/feevest.release.wasm
```

### Deploy to OPNet Testnet

```bash
# Deploy contract (no constructor calldata — uses initialize() pattern)
opnet deploy \
  --network testnet \
  --wasm build/feevest.release.wasm \
  --gasSatFee 10000

# After deployment, call initialize once as owner:
# feeVest.initialize(revenueTokenAddress)
```

> **Note:** OPNet testnet delivers 0 bytes to `onDeploy()`, so token setup is done via the one-time `initialize()` call post-deployment. Use the Admin tab in the dashboard.

### Minimum gas

Use `gasSatFee: 10_000n` (or higher for large WASM). Values below this may revert silently.

---

## Architecture

```
depositAndVest()
  ├─ CHECKS:  validate inputs, verify no existing schedule
  ├─ EFFECTS: updateReward snapshot, write schedule, increase totalLocked
  └─ INTERACT: transferFrom(depositor → vault)

depositRevenue()
  ├─ CHECKS:  amount > 0, totalLocked > 0
  ├─ EFFECTS: rewardPerToken += (amount × 1e18) / totalLocked
  └─ INTERACT: transferFrom(depositor → vault)

release()
  ├─ CHECKS:  has schedule, releasable > 0
  ├─ EFFECTS: updateReward, mark released, decrease totalLocked, re-anchor debt
  └─ INTERACT: transfer(vault → beneficiary)

claimRevenue()
  ├─ CHECKS:  has schedule
  ├─ EFFECTS: updateReward, zero pendingRewards
  └─ INTERACT: transfer(vault → beneficiary)
```

---

## Security

- Audit: 0 critical — Bob MCP + manual review
- `StoredBoolean` reentrancy guard (not a class field — persists across call frames)
- No `tx.origin` — only `Blockchain.tx.sender`
- All u256 arithmetic via `SafeMath`
- No loops over unbounded data — O(1) everywhere
- One active schedule per beneficiary (griefing mitigation)

---

## Week 3 — VibeVestAIExecutor (Intent Automation Layer)

An intent-based executor that sits on top of the deployed PublicVesting contract.
Users sign typed intents off-chain; any relayer submits them on-chain.

### What the demo shows

| Feature | Status |
|---------|--------|
| **DEPOSIT_AND_VEST via signed intent** | Fully working — pull tokens from user, forward to PublicVesting |
| Schnorr BIP-340 signature + keccak256 domain separation | Verified on-chain |
| Sequential nonce replay protection | Enforced per-user |
| Block deadline expiry | Enforced |
| Owner risk guards (maxAmountPerTx, allowedToken, globalMinBlocksGap) | Configurable |
| Per-user throttle (max of global + intent hint) | Enforced |
| Conditional execution (minClaimable >= threshold) | Checked via cross-contract view call |
| RELEASE via executor | Limited — see below |
| CLAIM_REVENUE via executor | Limited — see below |

### Known limitation: RELEASE and CLAIM_REVENUE

PublicVesting uses `Blockchain.tx.sender` as the beneficiary in `release()` and `claimRevenue()`. When the executor calls these, `tx.sender = executor contract`, not the user. So these actions operate on the executor's own schedule, not the user's.

**This is not a bug — it's an architectural boundary.** We do NOT modify PublicVesting.

**Workarounds for users:**
- Users call `release()` and `claimRevenue()` directly from their own wallets (no executor needed for these simple calls).
- Production fix: add `releaseFor(beneficiary)` and `claimRevenueFor(beneficiary)` to a future PublicVesting version.

**The Week 3 demo focuses on:** intent-signed DEPOSIT_AND_VEST automation + full security stack (signature, nonce, deadline, risk guards, throttle).

### Executor Build & Deploy

```bash
npm run build:executor           # debug  → build/executor.debug.wasm
npm run build:executor:release   # release → build/executor.release.wasm (31 KB)
```

See [EXECUTOR_DEPLOY.md](./EXECUTOR_DEPLOY.md) for full audit, test scenarios, deployment steps, and JS integration snippet.

---

## License

MIT
