# VibeVestAIExecutor — Week 3 Breakthrough

Intent-based automation layer for PublicVesting (FeeVest) on OP_NET Bitcoin L1.

---

## 1. Architecture Overview

```
User Wallet                   Relayer Bot                  OP_NET Bitcoin L1
───────────                   ───────────                  ─────────────────
  │                              │
  │ 1. Sign intent off-chain     │
  │ ──────────────────────────►  │
  │                              │ 2. Submit tx: executeIntent(intent, sig)
  │                              │ ──────────────────────────────────────────►
  │                              │                    ┌─────────────────────────┐
  │                              │                    │  VibeVestAIExecutor     │
  │                              │                    │  ─────────────────────  │
  │                              │                    │  Verify signature       │
  │                              │                    │  Check nonce/deadline   │
  │                              │                    │  Enforce risk guards    │
  │                              │                    │  Dispatch action ──────►│── PublicVesting
  │                              │                    │  Emit IntentExecuted    │   (FeeVest)
  │                              │                    └─────────────────────────┘
```

### Supported Actions

| Action | Value | Description | Limitation |
|--------|-------|-------------|------------|
| DEPOSIT_AND_VEST | 0 | Pull tokens from user, create vesting schedule | None — works fully |
| RELEASE | 1 | Release vested tokens | Releases for executor address, not user |
| CLAIM_REVENUE | 2 | Claim accumulated revenue | Claims for executor address, not user |

---

## 2. Full OpNet Audit

### Security Checklist

| # | Check | Status | Notes |
|---|-------|--------|-------|
| 1 | Reentrancy guard | PASS | StoredBoolean persists across call frames |
| 2 | CEI pattern | PASS | All 6 checks → 2 effects → interaction in executeIntent |
| 3 | SafeMath | PASS | All arithmetic via SafeMath.add/sub/mul/div |
| 4 | No tx.origin | PASS | Only Blockchain.tx.sender used |
| 5 | Replay protection | PASS | Strict sequential nonce per user |
| 6 | Signature verification | PASS | keccak256 domain-separated digest + Blockchain.verifySignature (Schnorr) |
| 7 | Domain separation | PASS | Digest includes contract address + publicVesting address |
| 8 | Deadline check | PASS | block.number <= deadline enforced |
| 9 | Risk caps | PASS | maxAmountPerTx, allowedToken mapping |
| 10 | Throttle | PASS | max(globalMinBlocksGap, intent.minBlocksGap) enforced |
| 11 | Approval cleanup | PASS | Approval reset to 0 after depositAndVest |
| 12 | Input validation | PASS | Zero-address, zero-amount, unknown action checks |
| 13 | Owner-only admin | PASS | onlyOwner() on all setters |
| 14 | Initialize guard | PASS | Single-init pattern, requireInitialized() |
| 15 | No unbounded loops | PASS | O(1) operations throughout |
| 16 | Cross-contract calls | PASS | Return value checked on all external calls |

### Storage Layout

| Pointer | Field | Type | Description |
|---------|-------|------|-------------|
| 0 | _locked | StoredBoolean | Reentrancy lock |
| 1 | _owner | StoredAddress | Contract owner |
| 2 | _publicVesting | StoredAddress | FeeVest contract address |
| 3 | _maxAmountPerTx | StoredU256 | Max tokens per DEPOSIT_AND_VEST |
| 4 | _globalMinBlocksGap | StoredU256 | Min blocks between executions |
| 5 | _nextNonce | AddressMemoryMap | user → next expected nonce |
| 6 | _lastExecutedBlock | AddressMemoryMap | user → last execution block |
| 7 | _allowedToken | AddressMemoryMap | token → 1 (allowed) or 0 |

### Attack Vectors Analyzed

1. **Replay attack**: Prevented by strict sequential nonce. Each intent can execute exactly once.
2. **Front-running**: Signature binds intent to specific user — relayer substitution doesn't help attacker.
3. **Stale intent**: Deadline enforces time limit; throttle prevents rapid-fire execution.
4. **Token drain**: User explicitly approves executor; risk guards cap per-tx amount.
5. **Cross-contract reentrancy**: StoredBoolean guard + CEI ordering.
6. **Signature malleability**: Schnorr signatures on OP_NET are BIP-340 compliant (no malleability).

---

## 3. Test Scenarios

### Scenario 1: Happy Path — DEPOSIT_AND_VEST

```
Setup:
  - Deploy VibeVestAIExecutor, initialize with PublicVesting address
  - Owner calls setAllowedToken(FEE_TOKEN, 1)
  - Owner calls setRiskParams(1000000e18, 5)
  - User approves Executor for 1000 FEE tokens

Intent:
  user:          0xUSER_ADDRESS
  action:        0  (DEPOSIT_AND_VEST)
  token:         0xFEE_TOKEN_ADDRESS
  amount:        1000000000000000000000  (1000 × 1e18)
  beneficiary:   0xBENEFICIARY_ADDRESS
  durationDays:  30
  minClaimable:  0
  minBlocksGap:  10
  nonce:         0  (first intent)
  deadline:      999999  (far future block)

Expected:
  1. Signature verified against keccak256 digest
  2. Nonce 0 matches nextNonce[user] = 0
  3. Token is allowed, amount <= maxAmountPerTx
  4. No throttle issue (first execution)
  5. transferFrom(user → executor, 1000 FEE)
  6. approve(PublicVesting, 1000 FEE)
  7. PublicVesting.depositAndVest(1000 FEE, beneficiary, 0 cliff, 4320 blocks)
  8. approve(PublicVesting, 0)
  9. Event: IntentExecuted(user, 0, token, 1000e18, beneficiary, 30, relayer)
  10. nextNonce[user] = 1
```

### Scenario 2: Rejected — Expired Deadline

```
Setup: Same as Scenario 1

Intent:
  ... same fields ...
  deadline: 100  (already past)

Expected:
  - Revert: "Executor: intent expired"
  - No state changes
  - No token transfers
```

### Scenario 3: Rejected — Token Not Allowed

```
Setup:
  - Deploy and initialize
  - Do NOT call setAllowedToken for the intent's token

Intent:
  user:    0xUSER
  action:  0  (DEPOSIT_AND_VEST)
  token:   0xUNKNOWN_TOKEN
  amount:  100e18
  ...

Expected:
  - Revert: "Executor: token not allowed"
  - No state changes
```

### Example Signature Generation (conceptual)

```javascript
// 1. Build the digest (must match contract's computeIntentDigest exactly)
const domainTag = new TextEncoder().encode('VibeVestAIExecutor_v1');
const packed = Buffer.concat([
    domainTag,
    padAddress(executorAddress),   // 32 bytes
    padAddress(publicVestingAddr), // 32 bytes
    padAddress(userAddress),       // 32 bytes
    padU256(action),               // 32 bytes
    padAddress(tokenAddress),      // 32 bytes
    padU256(amount),               // 32 bytes
    padAddress(beneficiaryAddr),   // 32 bytes
    padU256(durationDays),         // 32 bytes
    padU256(minClaimable),         // 32 bytes
    padU256(minBlocksGap),         // 32 bytes
    padU256(nonce),                // 32 bytes
    padU256(deadline),             // 32 bytes
]);
const digest = keccak256(packed);

// 2. Sign with user's Schnorr key (BIP-340)
const signature = schnorrSign(userPrivateKey, digest); // 64 bytes

// 3. Build SchnorrSignature calldata bytes
const sigCalldata = Buffer.concat([
    userTweakedPublicKey, // 32 bytes (ExtendedAddress part 1)
    userPublicKeyHash,    // 32 bytes (ExtendedAddress part 2 — ML-DSA key hash)
    signature,            // 64 bytes (r || s)
]);
// Total: 128 bytes appended after the 10 intent fields
```

---

## 4. Deployment Instructions

### Build

```bash
# Debug build
npm run build:executor

# Release build (optimized)
npm run build:executor:release
```

Output: `build/executor.release.wasm`

### Deploy

```bash
# Deploy the executor contract WASM
opnet deploy \
  --network testnet \
  --wasm build/executor.release.wasm \
  --gasSatFee 10000
```

### Post-Deploy Setup (owner calls these transactions)

```bash
# 1. Initialize with the already-deployed PublicVesting address
executor.initialize(FEEVEST_CONTRACT_ADDRESS)

# 2. Set risk parameters
executor.setRiskParams(
  1000000000000000000000000,  # maxAmountPerTx = 1M tokens (1e24 with 18 decimals)
  5                            # globalMinBlocksGap = 5 blocks (~50 min)
)

# 3. Allow the FEE token
executor.setAllowedToken(FEE_TOKEN_ADDRESS, 1)
```

### Constructor Calldata

The constructor takes no calldata (OPNet testnet limitation). Use `initialize()`:

```
initialize(publicVesting: Address)
  - publicVesting: the deployed FeeVest contract address (32 bytes)
```

---

## 5. Frontend Integration — JS Snippet

```javascript
import { keccak256 } from '@noble/hashes/sha3';
import { schnorr } from '@noble/curves/secp256k1';
import { getContract, JSONRpcProvider, Wallet, networks } from '@btc-vision/btc-runtime/runtime';

// ─── Config ────────────────────────────────────────────────────────────────
const RPC_URL           = 'https://testnet.opnet.org';
const NETWORK           = networks.opnetTestnet;
const EXECUTOR_ADDR     = '0xYOUR_EXECUTOR_ADDRESS';
const PUBLIC_VESTING    = '0xYOUR_FEEVEST_ADDRESS';
const FEE_TOKEN         = '0xYOUR_FEE_TOKEN_ADDRESS';

// ─── Helper: pad to 32 bytes (big-endian) ──────────────────────────────────
function padAddress(hex) {
    // Address is 32 bytes in OPNet — strip 0x, hex-decode, pad/truncate to 32
    const clean = hex.replace(/^0x/, '');
    const bytes = Buffer.from(clean, 'hex');
    const padded = Buffer.alloc(32);
    bytes.copy(padded, 32 - bytes.length);
    return padded;
}

function padU256(value) {
    // value is BigInt — convert to 32-byte big-endian
    const hex = value.toString(16).padStart(64, '0');
    return Buffer.from(hex, 'hex');
}

// ─── Step 1: Build the intent digest ───────────────────────────────────────
async function buildIntentDigest(intent) {
    const domainTag = Buffer.from('VibeVestAIExecutor_v1', 'utf8');

    const packed = Buffer.concat([
        domainTag,
        padAddress(EXECUTOR_ADDR),
        padAddress(PUBLIC_VESTING),
        padAddress(intent.user),
        padU256(intent.action),
        padAddress(intent.token),
        padU256(intent.amount),
        padAddress(intent.beneficiary),
        padU256(intent.durationDays),
        padU256(intent.minClaimable),
        padU256(intent.minBlocksGap),
        padU256(intent.nonce),
        padU256(intent.deadline),
    ]);

    return keccak256(packed);
}

// ─── Step 2: Sign with user's key ──────────────────────────────────────────
async function signIntent(intent, privateKeyHex) {
    const digest = await buildIntentDigest(intent);

    // BIP-340 Schnorr signature (64 bytes)
    const signature = schnorr.sign(digest, privateKeyHex);

    return { digest, signature };
}

// ─── Step 3: Build calldata and submit ─────────────────────────────────────
async function submitIntent(intent, signature, tweakedPubKey, pubKeyHash) {
    const provider = new JSONRpcProvider(RPC_URL, NETWORK);

    // The relayer wallet submits the transaction
    const relayerWallet = Wallet.fromWIF(process.env.RELAYER_WIF, NETWORK);

    // Build the full calldata:
    // 10 intent fields (ABI-encoded) + SchnorrSignature (128 raw bytes)
    // The SDK handles ABI encoding; the signature is appended as raw bytes.

    const contract = getContract(EXECUTOR_ADDR, VibeVestAIExecutorAbi, provider, NETWORK, relayerWallet);

    const result = await contract.executeIntent(
        intent.user,
        intent.action,
        intent.token,
        intent.amount,
        intent.beneficiary,
        intent.durationDays,
        intent.minClaimable,
        intent.minBlocksGap,
        intent.nonce,
        intent.deadline,
        // SchnorrSignature bytes appended:
        // tweakedPubKey (32B) + pubKeyHash (32B) + signature (64B)
        Buffer.concat([tweakedPubKey, pubKeyHash, signature]),
    );

    console.log('Intent executed! TX:', result.txHash);
    return result;
}

// ─── Example usage ─────────────────────────────────────────────────────────
async function main() {
    const intent = {
        user:         '0xUSER_ADDRESS',
        action:       0n,  // DEPOSIT_AND_VEST
        token:        FEE_TOKEN,
        amount:       1000n * 10n ** 18n,
        beneficiary:  '0xBENEFICIARY_ADDRESS',
        durationDays: 30n,
        minClaimable: 0n,
        minBlocksGap: 10n,
        nonce:        0n,  // first intent — query getNextNonce() to confirm
        deadline:     999999n,
    };

    const USER_PRIVKEY = 'user_private_key_hex';
    const { signature } = await signIntent(intent, USER_PRIVKEY);

    // User's ExtendedAddress components (from wallet)
    const tweakedPubKey = Buffer.from('...', 'hex'); // 32 bytes
    const pubKeyHash    = Buffer.from('...', 'hex'); // 32 bytes

    await submitIntent(intent, signature, tweakedPubKey, pubKeyHash);
}

main().catch(console.error);
```

---

## 6. Known Limitations

### RELEASE and CLAIM_REVENUE act on executor address, not user

PublicVesting identifies beneficiaries by `Blockchain.tx.sender`. When the executor
calls `release()` or `claimRevenue()`, the vesting contract sees **the executor's address**
as the caller — not the original user who signed the intent.

**Practical impact:** these two actions are effectively no-ops for the user's schedule.
The enum values exist in the contract (Action 1 and 2) for forward-compatibility,
but in the current demo they do NOT release/claim on behalf of the user.

#### What works in the demo

- **DEPOSIT_AND_VEST (Action 0)** — fully working end-to-end. The executor pulls tokens
  from the user (who pre-approved it) and forwards them to PublicVesting with an explicit
  `beneficiary` parameter. This bypasses the tx.sender issue because depositAndVest
  accepts beneficiary as a call argument.
- **All security features** — signature verification, nonce, deadline, risk guards, throttle,
  conditional execution (minClaimable) — work for ALL action types.

#### What users do instead for release/claim

Users call `release()` and `claimRevenue()` **directly from their own wallets**.
These are simple one-click transactions — no intent signing needed.
The executor adds value for DEPOSIT_AND_VEST because that flow requires multi-step
token approval + cross-contract orchestration that benefits from automation.

#### Production fix (future PublicVesting version)

```
releaseFor(address beneficiary)      — authorized executor only
claimRevenueFor(address beneficiary) — authorized executor only
```

This would let the executor act on behalf of any user for all three actions.
We do NOT modify PublicVesting in this submission — it is treated as deployed and immutable.

### Block time assumption

`durationDays` is converted to blocks using `BLOCKS_PER_DAY = 144` (assuming ~10 min Bitcoin
blocks). Actual block times vary. For precise vesting, pass pre-calculated block counts.

### OPNet testnet calldata bug

`onDeployment()` receives 0 bytes on testnet. Constructor parameters must be set via
`initialize()` after deployment.

### Signature scheme

The contract uses Schnorr signatures (BIP-340) via `Blockchain.verifySignature()` with
domain-separated keccak256 digests. The signer must provide their full `ExtendedAddress`
(64 bytes: tweaked public key + ML-DSA key hash) alongside the 64-byte signature.

---

## File Summary

| File | Description |
|------|-------------|
| `src/VibeVestAIExecutor.ts` | Main contract (~500 lines) |
| `src/events/ExecutorEvents.ts` | Event definitions |
| `src/index_executor.ts` | WASM entry point |
| `abis/VibeVestAIExecutor.abi.ts` | ABI for frontend SDK |
| `asconfig.json` | Build targets (executor-debug, executor-release) |
| `package.json` | Build scripts (build:executor, build:executor:release) |
