# FeeVest — Deployment & Testing Guide

## Deployed Contracts (OPNet Testnet)

> Update this table after your deployment.

| Contract | Bech32 Address | SDK Hex Address |
|----------|----------------|-----------------|
| **FeeVest** | `opt1s...` | `0x...` |
| **FeeToken (FEE)** | `opt1s...` | `0x...` |

| Parameter | Value |
|-----------|-------|
| Network | OPNet Testnet (Signet fork) |
| Explorer | https://opscan.org |

> **Note:** Use the SDK Hex Address (`0x...`) for `getContract()`. The bech32 (`opt1...`) is for explorer/display only.

---

## Prerequisites

1. **OP_WALLET** browser extension installed
2. **Testnet sats** — fund via OPNet testnet faucet
3. **Node.js 18+** and **npm** installed

## Network Configuration

| Parameter | Value |
|-----------|-------|
| Network | OPNet Testnet (Signet fork) |
| RPC URL | `https://testnet.opnet.org` |
| Network constant | `networks.opnetTestnet` from `@btc-vision/bitcoin` |

> **CRITICAL:** Use `networks.opnetTestnet` — NOT `networks.testnet` (that is Testnet4, unsupported by OPNet).

---

## Step 1: Build

```bash
npm install
npm run build          # debug  → build/feevest.debug.wasm
npm run build:release  # release → build/feevest.release.wasm
```

Optionally build the mock FeeToken too:

```bash
npm run build:token
# → build/feedtoken.debug.wasm
```

---

## Step 2: Deploy FeeToken (optional mock)

If you need a token for testing, deploy `FeeToken` first:

1. Open **OP_WALLET** → switch to **OPNet Testnet**
2. Click **Deploy** → drag `build/feetoken.debug.wasm`
3. Leave calldata **empty** (known OPNet testnet limitation)
4. Confirm — note the contract address
5. Call `mint(yourAddress, 1000000000000000000000000n)` to mint test tokens

---

## Step 3: Deploy FeeVest

1. Open **OP_WALLET** → switch to **OPNet Testnet**
2. Click **Deploy** → drag `build/feevest.release.wasm`
3. Leave calldata **empty** — Known OPNet testnet bug: node delivers 0 bytes to `onDeploy()`, reading calldata would revert. Token is set via `initialize()` instead.
4. Confirm both funding + reveal transactions
5. Wait ~1-2 blocks
6. Note the **FeeVest contract address** from the deployment receipt

---

## Step 4: Initialize (one-time)

**Immediately after deployment**, owner must call `initialize(revenueToken)`:

```ts
await feeVest.initialize(FEE_TOKEN_ADDRESS);
```

- Sets the single OP_20 token for both vesting and revenue permanently
- Can only be called once — reverts if already initialized
- After this, no further owner actions are required for the core protocol

Do this via:
- **Dashboard** → Admin tab → "Initialize FeeVest"
- Test script (`test/test-feevest-flow.ts`)

---

## Step 5: Full Test Flow

```
1. Deploy FeeToken  → mint tokens to depositor + owner wallets
2. Deploy FeeVest
3. Owner: initialize(feeTokenAddress)
4. Depositor: increaseAllowance(feeVestAddress, 1000e18)  ← on FeeToken
5. Depositor: depositAndVest(1000e18, beneficiary, 10, 100)
   → 10 block cliff, 100 block total linear vest
6. RevenueDepositor: increaseAllowance(feeVestAddress, 500e18)
7. RevenueDepositor: depositRevenue(500e18)
8. Wait 10+ blocks (cliff)
9. Beneficiary: release()  → receives vested tokens
10. Beneficiary: claimRevenue()  → receives revenue share
11. Query: getVesting(beneficiary)  → verify released == releasable
```

See `test/test-feevest-flow.ts` for a scripted end-to-end version.

---

## ABI Reference

Full ABI: `abis/FeeVest.abi.json`

| Method | Selector | Type |
|--------|----------|------|
| `initialize(address)` | `0xd78a3125` | Write (owner, once) |
| `depositAndVest(uint256,address,uint256,uint256)` | `0xfcdfb559` | Write (public) |
| `release()` | `0xca66fa8a` | Write |
| `depositRevenue(uint256)` | `0x5868922b` | Write (public) |
| `claimRevenue()` | `0xdba5add9` | Write |
| `getVesting(address)` | `0x6b5d8619` | View |
| `getPendingRelease(address)` | `0xfebf6cfe` | View |
| `getClaimableRevenue(address)` | `0xdf13a905` | View |
| `totalLocked()` | `0x885dc9b0` | View |
| `totalRevenueDeposited()` | `0x86c091af` | View |
| `revenueToken()` | `0xa37f8d09` | View |
| `owner()` | `0x3fc2bcdd` | View |
