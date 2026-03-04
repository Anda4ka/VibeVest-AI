import { u256 } from '@btc-vision/as-bignum/assembly';
import {
    Address,
    Blockchain,
    BytesWriter,
    Calldata,
    encodeSelector,
    OP_NET,
    Revert,
    SafeMath,
    StoredU256,
    StoredBoolean,
    StoredAddress,
    AddressMemoryMap,
    EMPTY_POINTER,
} from '@btc-vision/btc-runtime/runtime';
import { CallResult } from '@btc-vision/btc-runtime/runtime/env/BlockchainEnvironment';

import {
    VestingCreatedEvent,
    TokensReleasedEvent,
    RevenueDepositedEvent,
    RevenueClaimedEvent,
} from './events/FeeVestEvents';

/**
 * FeeVest — Public Fee-to-Vesting on OPNet (Bitcoin L1).
 *
 * A fully permissionless vesting vault. Any address can call depositAndVest()
 * to lock tokens and create a linear vesting schedule for any beneficiary.
 * Protocol fees forwarded via depositRevenue() are distributed proportionally
 * to all active locked-token holders using the Synthetix O(1) reward-per-token
 * accumulator — no iteration over beneficiary lists, ever.
 *
 * ─── Key differences from VestingVault ─────────────────────────────────────
 *  • depositAndVest() is fully public — no owner restriction on vesting creation.
 *  • Single OP_20 token used for both vesting and revenue distribution.
 *  • New event: VestingCreated(beneficiary, amount, cliff, duration, depositor).
 *  • Owner retained only for initialize() (one-time token setup). Not required
 *    for any core protocol function.
 *
 * ─── Security properties ────────────────────────────────────────────────────
 *  • Persistent StoredBoolean reentrancy guard — survives cross-contract calls.
 *  • Strict Checks-Effects-Interactions on every state-changing method.
 *  • SafeMath for all u256 arithmetic — no raw +/−/× operators.
 *  • No tx.origin — only Blockchain.tx.sender.
 *  • No loops over unbounded data — O(1) accumulator pattern throughout.
 *  • No public mint or arbitrary withdrawal — only release() for beneficiaries.
 */
@final
export class FeeVest extends OP_NET {
    // ─── OP20 method selectors (SHA-256 first 4 bytes — OPNet convention) ────
    private static readonly TRANSFER_SELECTOR: u32 = encodeSelector('transfer(address,uint256)');
    private static readonly TRANSFER_FROM_SELECTOR: u32 = encodeSelector(
        'transferFrom(address,address,uint256)',
    );

    /** 1e18 precision multiplier for reward-per-token accumulator math. */
    private static readonly PRECISION: u256 = u256.fromString('1000000000000000000');

    // ─── Global storage pointers — allocated in strict declaration order ─────
    private readonly lockedPointer: u16 = Blockchain.nextPointer;          // reentrancy lock
    private readonly ownerPointer: u16 = Blockchain.nextPointer;           // contract owner
    private readonly tokenPointer: u16 = Blockchain.nextPointer;           // OP_20 token address
    private readonly totalLockedPointer: u16 = Blockchain.nextPointer;     // Σ all locked balances
    private readonly rewardPerTokenPointer: u16 = Blockchain.nextPointer;  // global accumulator
    private readonly totalRevenuePointer: u16 = Blockchain.nextPointer;    // Σ revenue deposited

    // ─── Per-beneficiary vesting schedule fields (address → u256) ───────────
    private readonly vestAmountPointer: u16 = Blockchain.nextPointer;      // total tokens locked
    private readonly vestStartPointer: u16 = Blockchain.nextPointer;       // start block
    private readonly vestCliffPointer: u16 = Blockchain.nextPointer;       // cliff duration (blocks)
    private readonly vestDurationPointer: u16 = Blockchain.nextPointer;    // total vesting (blocks)
    private readonly releasedPointer: u16 = Blockchain.nextPointer;        // tokens already released

    // ─── Per-beneficiary revenue accumulator state (address → u256) ─────────
    private readonly rewardDebtPointer: u16 = Blockchain.nextPointer;      // last-seen RPT snapshot
    private readonly pendingRewardsPointer: u16 = Blockchain.nextPointer;  // stored unclaimed rev

    // ─── Persistent reentrancy lock ──────────────────────────────────────────
    // StoredBoolean writes to persistent storage — survives cross-contract re-entry.
    // A class field (bool) would reset on each call frame and is NOT safe.
    private readonly _locked: StoredBoolean = new StoredBoolean(this.lockedPointer, false);

    // ─── Global state ────────────────────────────────────────────────────────
    private readonly _owner: StoredAddress = new StoredAddress(this.ownerPointer);
    private readonly _token: StoredAddress = new StoredAddress(this.tokenPointer);
    private readonly _totalLocked: StoredU256 = new StoredU256(
        this.totalLockedPointer,
        EMPTY_POINTER,
    );
    private readonly _rewardPerToken: StoredU256 = new StoredU256(
        this.rewardPerTokenPointer,
        EMPTY_POINTER,
    );
    private readonly _totalRevenue: StoredU256 = new StoredU256(
        this.totalRevenuePointer,
        EMPTY_POINTER,
    );

    // ─── Per-beneficiary maps ────────────────────────────────────────────────
    private readonly _vestAmount: AddressMemoryMap = new AddressMemoryMap(
        this.vestAmountPointer,
    );
    private readonly _vestStart: AddressMemoryMap = new AddressMemoryMap(
        this.vestStartPointer,
    );
    private readonly _vestCliff: AddressMemoryMap = new AddressMemoryMap(
        this.vestCliffPointer,
    );
    private readonly _vestDuration: AddressMemoryMap = new AddressMemoryMap(
        this.vestDurationPointer,
    );
    private readonly _released: AddressMemoryMap = new AddressMemoryMap(this.releasedPointer);
    private readonly _rewardDebt: AddressMemoryMap = new AddressMemoryMap(this.rewardDebtPointer);
    private readonly _pendingRewards: AddressMemoryMap = new AddressMemoryMap(
        this.pendingRewardsPointer,
    );

    public constructor() {
        super();
    }

    /**
     * Deployment hook — runs ONCE on first deployment.
     *
     * ⚠️  Known OPNet testnet limitation: the node delivers 0 bytes to onDeploy(),
     * so constructor calldata cannot be decoded here (BytesReader would throw).
     * Use the one-time initialize() method after deployment to set the token address.
     */
    public override onDeployment(_calldata: Calldata): void {
        this._owner.value = Blockchain.tx.sender;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ADMIN — owner-only, one-time setup
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Sets the OP_20 token used for vesting and revenue.
     * Owner-only, callable exactly once.
     * Must be called before any depositAndVest() or depositRevenue() call.
     *
     * @param revenueToken  Address of the OP_20 token this contract vests and distributes.
     */
    @method({ name: 'revenueToken', type: ABIDataTypes.ADDRESS })
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public initialize(calldata: Calldata): BytesWriter {
        this.onlyOwner();

        if (!this._token.value.isZero()) {
            throw new Revert('FeeVest: already initialized');
        }

        const revenueToken: Address = calldata.readAddress();
        if (revenueToken.isZero()) {
            throw new Revert('FeeVest: token is zero address');
        }

        this._token.value = revenueToken;

        const writer = new BytesWriter(1);
        writer.writeBoolean(true);
        return writer;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // CORE — permissionless vesting creation
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Public, permissionless vesting creation.
     *
     * Any address can vest tokens for any beneficiary. The caller must have
     * pre-approved this contract to spend `amount` of the token via OP_20.approve().
     * Each beneficiary can hold exactly one active schedule at a time.
     *
     * Strict CEI order:
     *   1. CHECKS   — validate all inputs, verify no existing schedule.
     *   2. EFFECTS  — update accumulator snapshot, write vesting schedule to storage.
     *   3. INTERACTION — pull tokens from caller via OP_20.transferFrom().
     *
     * @param amount          Token amount to lock for vesting.
     * @param beneficiary     Recipient who will be able to release vested tokens.
     * @param cliffDuration   Blocks that must pass before any tokens are releasable.
     * @param vestingDuration Total blocks over which tokens vest linearly from start.
     *
     * @emits VestingCreated(beneficiary, amount, cliffDuration, vestingDuration, msg.sender)
     */
    @method(
        { name: 'amount', type: ABIDataTypes.UINT256 },
        { name: 'beneficiary', type: ABIDataTypes.ADDRESS },
        { name: 'cliffDuration', type: ABIDataTypes.UINT256 },
        { name: 'vestingDuration', type: ABIDataTypes.UINT256 },
    )
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public depositAndVest(calldata: Calldata): BytesWriter {
        this.nonReentrant();
        this.requireInitialized();

        const amount: u256 = calldata.readU256();
        const beneficiary: Address = calldata.readAddress();
        const cliffDuration: u256 = calldata.readU256();
        const vestingDuration: u256 = calldata.readU256();
        const depositor: Address = Blockchain.tx.sender;

        // ── CHECKS ─────────────────────────────────────────────────────────────
        if (beneficiary.isZero()) {
            throw new Revert('FeeVest: beneficiary is zero address');
        }
        if (u256.eq(amount, u256.Zero)) {
            throw new Revert('FeeVest: amount is zero');
        }
        if (u256.eq(vestingDuration, u256.Zero)) {
            throw new Revert('FeeVest: vestingDuration is zero');
        }
        if (u256.gt(cliffDuration, vestingDuration)) {
            throw new Revert('FeeVest: cliff exceeds vestingDuration');
        }

        // One active schedule per beneficiary prevents griefing (tiny-amount spam).
        // A new schedule can only be created once the beneficiary has no existing one.
        const existingAmount: u256 = this._vestAmount.get(beneficiary);
        if (u256.gt(existingAmount, u256.Zero)) {
            throw new Revert('FeeVest: beneficiary already has active vesting');
        }

        // ── EFFECTS ────────────────────────────────────────────────────────────
        // Snapshot the accumulator BEFORE the locked balance changes so the
        // beneficiary does not retroactively earn revenue from before this block.
        this.updateReward(beneficiary);

        const currentBlock: u256 = Blockchain.block.numberU256;
        this._vestAmount.set(beneficiary, amount);
        this._vestStart.set(beneficiary, currentBlock);
        this._vestCliff.set(beneficiary, cliffDuration);
        this._vestDuration.set(beneficiary, vestingDuration);
        this._released.set(beneficiary, u256.Zero);

        // Increase global locked total.
        this._totalLocked.value = SafeMath.add(this._totalLocked.value, amount);

        // Anchor reward debt at current accumulator value.
        // The beneficiary earns revenue only on future deposits from this block onward.
        this._rewardDebt.set(beneficiary, this._rewardPerToken.value);

        // ── INTERACTION ────────────────────────────────────────────────────────
        this.callTransferFrom(this._token.value, depositor, amount);

        this.emitEvent(
            new VestingCreatedEvent(beneficiary, amount, cliffDuration, vestingDuration, depositor),
        );
        this.releaseGuard();

        const writer = new BytesWriter(1);
        writer.writeBoolean(true);
        return writer;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // CORE — release vested tokens
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Releases all currently vested tokens to msg.sender (the beneficiary).
     * Only the beneficiary can trigger their own release.
     *
     * Strict CEI order: checks → effects (accumulator + state update) → transfer.
     */
    @method()
    @returns({ name: 'amount', type: ABIDataTypes.UINT256 })
    public release(calldata: Calldata): BytesWriter {
        this.nonReentrant();
        this.requireInitialized();

        const beneficiary: Address = Blockchain.tx.sender;
        const totalAmount: u256 = this._vestAmount.get(beneficiary);

        // ── CHECKS ─────────────────────────────────────────────────────────────
        if (u256.eq(totalAmount, u256.Zero)) {
            throw new Revert('FeeVest: no vesting schedule');
        }

        // Compute releasable (pure read) before touching any state.
        const releasable: u256 = this.computeReleasable(beneficiary);
        if (u256.eq(releasable, u256.Zero)) {
            throw new Revert('FeeVest: nothing to release');
        }

        // ── EFFECTS ────────────────────────────────────────────────────────────
        // Snapshot revenue BEFORE locked balance decreases so the beneficiary
        // earns the correct share up to this exact block.
        this.updateReward(beneficiary);

        // Mark tokens as released.
        const alreadyReleased: u256 = this._released.get(beneficiary);
        this._released.set(beneficiary, SafeMath.add(alreadyReleased, releasable));

        // Decrease global locked total.
        this._totalLocked.value = SafeMath.sub(this._totalLocked.value, releasable);

        // Re-anchor reward debt after the locked balance change.
        this._rewardDebt.set(beneficiary, this._rewardPerToken.value);

        // ── INTERACTION ────────────────────────────────────────────────────────
        this.callTransfer(this._token.value, beneficiary, releasable);

        this.emitEvent(new TokensReleasedEvent(beneficiary, releasable));
        this.releaseGuard();

        const writer = new BytesWriter(32);
        writer.writeU256(releasable);
        return writer;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // CORE — revenue distribution
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Deposits revenue tokens for proportional distribution to all locked-token holders.
     * Fully public — any address (protocol fee router, DAO, individual) can call this.
     * Caller must pre-approve this contract for `amount` tokens via OP_20.approve().
     *
     * Uses O(1) Synthetix-style reward-per-token accumulator:
     *   rewardPerToken += (amount × PRECISION) / totalLocked
     *
     * @param amount  Revenue amount to distribute.
     */
    @method({ name: 'amount', type: ABIDataTypes.UINT256 })
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public depositRevenue(calldata: Calldata): BytesWriter {
        this.nonReentrant();
        this.requireInitialized();

        const amount: u256 = calldata.readU256();

        // ── CHECKS ─────────────────────────────────────────────────────────────
        if (u256.eq(amount, u256.Zero)) {
            throw new Revert('FeeVest: revenue amount is zero');
        }

        const totalLocked: u256 = this._totalLocked.value;
        if (u256.eq(totalLocked, u256.Zero)) {
            throw new Revert('FeeVest: no locked tokens to distribute to');
        }

        // ── EFFECTS ────────────────────────────────────────────────────────────
        // rewardPerToken += (amount × PRECISION) / totalLocked
        const scaledAmount: u256 = SafeMath.mul(amount, FeeVest.PRECISION);
        const rewardIncrement: u256 = SafeMath.div(scaledAmount, totalLocked);
        this._rewardPerToken.value = SafeMath.add(this._rewardPerToken.value, rewardIncrement);
        this._totalRevenue.value = SafeMath.add(this._totalRevenue.value, amount);

        // ── INTERACTION ────────────────────────────────────────────────────────
        this.callTransferFrom(this._token.value, Blockchain.tx.sender, amount);

        this.emitEvent(new RevenueDepositedEvent(Blockchain.tx.sender, amount));
        this.releaseGuard();

        const writer = new BytesWriter(1);
        writer.writeBoolean(true);
        return writer;
    }

    /**
     * Claims all accumulated revenue for msg.sender.
     * Only beneficiaries with an active vesting schedule can claim.
     *
     * Strict CEI: updateReward (effect) → zero pending (effect) → transfer (interaction).
     */
    @method()
    @returns({ name: 'amount', type: ABIDataTypes.UINT256 })
    public claimRevenue(calldata: Calldata): BytesWriter {
        this.nonReentrant();
        this.requireInitialized();

        const beneficiary: Address = Blockchain.tx.sender;

        // ── CHECKS ─────────────────────────────────────────────────────────────
        if (u256.eq(this._vestAmount.get(beneficiary), u256.Zero)) {
            throw new Revert('FeeVest: no vesting schedule');
        }

        // ── EFFECTS ────────────────────────────────────────────────────────────
        // Flush any newly-accrued revenue into pendingRewards.
        this.updateReward(beneficiary);

        const pending: u256 = this._pendingRewards.get(beneficiary);
        if (u256.eq(pending, u256.Zero)) {
            throw new Revert('FeeVest: no revenue to claim');
        }

        // Zero out stored pending BEFORE the external call (CEI).
        this._pendingRewards.set(beneficiary, u256.Zero);

        // ── INTERACTION ────────────────────────────────────────────────────────
        this.callTransfer(this._token.value, beneficiary, pending);

        this.emitEvent(new RevenueClaimedEvent(beneficiary, pending));
        this.releaseGuard();

        const writer = new BytesWriter(32);
        writer.writeU256(pending);
        return writer;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // VIEW FUNCTIONS — read-only, no state mutation
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Returns the active vesting schedule for a beneficiary.
     * Each beneficiary holds at most one schedule at a time.
     * All zero values indicate no active schedule.
     *
     * Returns: totalAmount, startBlock, cliffDuration, vestingDuration,
     *          released, releasable (6 × u256).
     */
    @method({ name: 'beneficiary', type: ABIDataTypes.ADDRESS })
    @returns(
        { name: 'totalAmount', type: ABIDataTypes.UINT256 },
        { name: 'startBlock', type: ABIDataTypes.UINT256 },
        { name: 'cliffDuration', type: ABIDataTypes.UINT256 },
        { name: 'vestingDuration', type: ABIDataTypes.UINT256 },
        { name: 'released', type: ABIDataTypes.UINT256 },
        { name: 'releasable', type: ABIDataTypes.UINT256 },
    )
    public getVesting(calldata: Calldata): BytesWriter {
        const beneficiary: Address = calldata.readAddress();

        const totalAmount: u256 = this._vestAmount.get(beneficiary);
        const startBlock: u256 = this._vestStart.get(beneficiary);
        const cliffDuration: u256 = this._vestCliff.get(beneficiary);
        const vestDuration: u256 = this._vestDuration.get(beneficiary);
        const released: u256 = this._released.get(beneficiary);
        const releasable: u256 = this.computeReleasable(beneficiary);

        const writer = new BytesWriter(32 * 6);
        writer.writeU256(totalAmount);
        writer.writeU256(startBlock);
        writer.writeU256(cliffDuration);
        writer.writeU256(vestDuration);
        writer.writeU256(released);
        writer.writeU256(releasable);
        return writer;
    }

    /**
     * Returns the amount of vested tokens that msg.sender (or any beneficiary)
     * can release right now — i.e., vested minus already released.
     */
    @method({ name: 'beneficiary', type: ABIDataTypes.ADDRESS })
    @returns({ name: 'amount', type: ABIDataTypes.UINT256 })
    public getPendingRelease(calldata: Calldata): BytesWriter {
        const beneficiary: Address = calldata.readAddress();

        const writer = new BytesWriter(32);
        writer.writeU256(this.computeReleasable(beneficiary));
        return writer;
    }

    /**
     * Returns the total claimable revenue for a beneficiary.
     * Includes both stored pending rewards and any newly accrued (not yet flushed) revenue.
     * Pure view — does NOT write state.
     */
    @method({ name: 'beneficiary', type: ABIDataTypes.ADDRESS })
    @returns({ name: 'amount', type: ABIDataTypes.UINT256 })
    public getClaimableRevenue(calldata: Calldata): BytesWriter {
        const beneficiary: Address = calldata.readAddress();

        const writer = new BytesWriter(32);
        writer.writeU256(this.computePendingRevenue(beneficiary));
        return writer;
    }

    /** Returns total tokens currently locked across all active vesting schedules. */
    @method()
    @returns({ name: 'amount', type: ABIDataTypes.UINT256 })
    public totalLocked(calldata: Calldata): BytesWriter {
        const writer = new BytesWriter(32);
        writer.writeU256(this._totalLocked.value);
        return writer;
    }

    /** Returns cumulative revenue ever deposited into this vault since deployment. */
    @method()
    @returns({ name: 'amount', type: ABIDataTypes.UINT256 })
    public totalRevenueDeposited(calldata: Calldata): BytesWriter {
        const writer = new BytesWriter(32);
        writer.writeU256(this._totalRevenue.value);
        return writer;
    }

    /** Returns the OP_20 token address used for both vesting and revenue. */
    @method()
    @returns({ name: 'token', type: ABIDataTypes.ADDRESS })
    public revenueToken(calldata: Calldata): BytesWriter {
        const writer = new BytesWriter(32);
        writer.writeAddress(this._token.value);
        return writer;
    }

    /** Returns the contract owner address. */
    @method()
    @returns({ name: 'ownerAddress', type: ABIDataTypes.ADDRESS })
    public owner(calldata: Calldata): BytesWriter {
        const writer = new BytesWriter(32);
        writer.writeAddress(this._owner.value);
        return writer;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // INTERNAL HELPERS — private, not callable externally
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Acquires the reentrancy lock.
     * Uses persistent StoredBoolean — safe against cross-contract re-entry.
     * Reverts if the lock is already held (i.e., we are mid-execution).
     */
    private nonReentrant(): void {
        if (this._locked.value) {
            throw new Revert('FeeVest: reentrant call');
        }
        this._locked.value = true;
    }

    /** Releases the reentrancy lock. Must be called at the end of every guarded method. */
    private releaseGuard(): void {
        this._locked.value = false;
    }

    /** Reverts if the caller is not the contract owner. */
    private onlyOwner(): void {
        if (!Blockchain.tx.sender.equals(this._owner.value)) {
            throw new Revert('FeeVest: caller is not owner');
        }
    }

    /** Reverts if initialize() has not been called yet. */
    private requireInitialized(): void {
        if (this._token.value.isZero()) {
            throw new Revert('FeeVest: not initialized');
        }
    }

    /**
     * Snapshots and accrues earned revenue for a beneficiary.
     * MUST be called before ANY change to the beneficiary's locked balance to ensure
     * the accumulator captures the correct per-token share for the old balance.
     *
     * Formula: earned = lockedBalance × (currentRPT − rewardDebt) / PRECISION
     *
     * For new beneficiaries (lockedBalance = 0) we simply anchor the debt pointer
     * so they do not retroactively earn on revenue that pre-dated their schedule.
     */
    private updateReward(beneficiary: Address): void {
        const lockedBalance: u256 = this.getLockedBalance(beneficiary);
        if (u256.eq(lockedBalance, u256.Zero)) {
            // Anchor debt — prevents retroactive earnings on future deposits.
            this._rewardDebt.set(beneficiary, this._rewardPerToken.value);
            return;
        }

        const currentRpt: u256 = this._rewardPerToken.value;
        const userDebt: u256 = this._rewardDebt.get(beneficiary);

        // earned = lockedBalance × (currentRPT − userDebt) / PRECISION
        const rewardDelta: u256 = SafeMath.sub(currentRpt, userDebt);
        const earned: u256 = SafeMath.div(
            SafeMath.mul(lockedBalance, rewardDelta),
            FeeVest.PRECISION,
        );

        const currentPending: u256 = this._pendingRewards.get(beneficiary);
        this._pendingRewards.set(beneficiary, SafeMath.add(currentPending, earned));
        this._rewardDebt.set(beneficiary, currentRpt);
    }

    /**
     * Returns the currently locked (not yet released) balance for a beneficiary.
     * locked = totalVestingAmount − alreadyReleased
     */
    private getLockedBalance(beneficiary: Address): u256 {
        const totalAmount: u256 = this._vestAmount.get(beneficiary);
        if (u256.eq(totalAmount, u256.Zero)) {
            return u256.Zero;
        }
        const released: u256 = this._released.get(beneficiary);
        return SafeMath.sub(totalAmount, released);
    }

    /**
     * Computes the total amount vested so far for a beneficiary.
     * Uses block height — tamper-proof and fully deterministic on OPNet.
     *
     * Timeline:
     *   [0, start+cliff)         → 0 vested (cliff not passed)
     *   [start+cliff, start+dur) → linear: totalAmount × elapsed / duration
     *   [start+dur, ∞)           → totalAmount (fully vested)
     */
    private computeVested(beneficiary: Address): u256 {
        const totalAmount: u256 = this._vestAmount.get(beneficiary);
        if (u256.eq(totalAmount, u256.Zero)) {
            return u256.Zero;
        }

        const startBlock: u256 = this._vestStart.get(beneficiary);
        const cliffDuration: u256 = this._vestCliff.get(beneficiary);
        const vestDuration: u256 = this._vestDuration.get(beneficiary);
        const currentBlock: u256 = Blockchain.block.numberU256;

        // Before cliff — nothing vested yet.
        const cliffEnd: u256 = SafeMath.add(startBlock, cliffDuration);
        if (u256.lt(currentBlock, cliffEnd)) {
            return u256.Zero;
        }

        // After full vesting period — everything is vested.
        const vestEnd: u256 = SafeMath.add(startBlock, vestDuration);
        if (currentBlock >= vestEnd) {
            return totalAmount;
        }

        // Linear interpolation: totalAmount × elapsed / vestingDuration.
        const elapsed: u256 = SafeMath.sub(currentBlock, startBlock);
        return SafeMath.div(SafeMath.mul(totalAmount, elapsed), vestDuration);
    }

    /**
     * Releasable = vested − alreadyReleased.
     * Returns zero if the vested amount has not increased since last release.
     */
    private computeReleasable(beneficiary: Address): u256 {
        const vested: u256 = this.computeVested(beneficiary);
        const released: u256 = this._released.get(beneficiary);

        if (vested <= released) {
            return u256.Zero;
        }

        return SafeMath.sub(vested, released);
    }

    /**
     * Pure-view calculation of pending revenue (stored + newly accrued).
     * Safe to call from view methods — does NOT write to storage.
     */
    private computePendingRevenue(beneficiary: Address): u256 {
        const lockedBalance: u256 = this.getLockedBalance(beneficiary);
        const storedPending: u256 = this._pendingRewards.get(beneficiary);

        if (u256.eq(lockedBalance, u256.Zero)) {
            return storedPending;
        }

        const currentRpt: u256 = this._rewardPerToken.value;
        const userDebt: u256 = this._rewardDebt.get(beneficiary);
        const rewardDelta: u256 = SafeMath.sub(currentRpt, userDebt);
        const earned: u256 = SafeMath.div(
            SafeMath.mul(lockedBalance, rewardDelta),
            FeeVest.PRECISION,
        );

        return SafeMath.add(storedPending, earned);
    }

    /**
     * Cross-contract call: OP20 transfer(to, amount).
     * Used when releasing vested tokens or paying out claimed revenue.
     */
    private callTransfer(token: Address, to: Address, amount: u256): void {
        const writer = new BytesWriter(4 + 32 + 32);
        writer.writeSelector(FeeVest.TRANSFER_SELECTOR);
        writer.writeAddress(to);
        writer.writeU256(amount);

        const result: CallResult = Blockchain.call(token, writer, true);
        if (result.data.byteLength > 0) {
            if (!result.data.readBoolean()) {
                throw new Revert('FeeVest: token transfer failed');
            }
        }
    }

    /**
     * Cross-contract call: OP20 transferFrom(from, vault, amount).
     * Used to pull tokens from a depositor who has pre-approved this contract.
     * Note: `to` is always Blockchain.contractAddress (this vault), never tx.origin.
     */
    private callTransferFrom(token: Address, from: Address, amount: u256): void {
        const writer = new BytesWriter(4 + 32 + 32 + 32);
        writer.writeSelector(FeeVest.TRANSFER_FROM_SELECTOR);
        writer.writeAddress(from);
        writer.writeAddress(Blockchain.contractAddress); // spender = this vault
        writer.writeU256(amount);

        const result: CallResult = Blockchain.call(token, writer, true);
        if (result.data.byteLength > 0) {
            if (!result.data.readBoolean()) {
                throw new Revert('FeeVest: token transferFrom failed');
            }
        }
    }
}
