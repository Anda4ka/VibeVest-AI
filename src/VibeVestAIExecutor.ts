import { u256 } from '@btc-vision/as-bignum/assembly';
import {
    Address,
    Blockchain,
    BytesWriter,
    Calldata,
    encodeSelector,
    ExtendedAddress,
    keccak256,
    OP_NET,
    Revert,
    SafeMath,
    SchnorrSignature,
    StoredU256,
    StoredBoolean,
    StoredAddress,
    AddressMemoryMap,
    EMPTY_POINTER,
} from '@btc-vision/btc-runtime/runtime';
import { CallResult } from '@btc-vision/btc-runtime/runtime/env/BlockchainEnvironment';

import {
    IntentExecutedEvent,
    RiskParamsUpdatedEvent,
    AllowedTokenUpdatedEvent,
    PublicVestingUpdatedEvent,
} from './events/ExecutorEvents';

/**
 * VibeVestAIExecutor — Intent-based automation layer for PublicVesting (FeeVest)
 * on OP_NET Bitcoin L1.
 *
 * Week 3 Breakthrough: users sign typed intents off-chain; any relayer can submit
 * them on-chain. The executor validates the signature, enforces risk guards and
 * throttle, then dispatches the action to the deployed PublicVesting contract.
 *
 * ─── Supported actions ──────────────────────────────────────────────────────
 *  0 = DEPOSIT_AND_VEST  — pull tokens from user, forward to PublicVesting
 *  1 = RELEASE           — call PublicVesting.release()  (⚠ limited — see notes)
 *  2 = CLAIM_REVENUE     — call PublicVesting.claimRevenue() (⚠ limited — see notes)
 *
 * ─── Security properties ────────────────────────────────────────────────────
 *  • Persistent StoredBoolean reentrancy guard — survives cross-contract calls.
 *  • Strict Checks-Effects-Interactions on every state-changing path.
 *  • SafeMath for all u256 arithmetic — no raw operators.
 *  • Keccak256 domain-separated digest + Schnorr signature verification.
 *  • Replay protection via strict sequential nonces per user.
 *  • Block deadline prevents stale intent execution.
 *  • Owner-configurable risk guards: maxAmountPerTx, globalMinBlocksGap,
 *    per-token allowlist.
 *
 * ─── Demo scope & known limitations ────────────────────────────────────────
 *  • DEPOSIT_AND_VEST works end-to-end: user approves executor, executor
 *    pulls tokens and forwards them to PublicVesting with explicit beneficiary.
 *  • RELEASE and CLAIM_REVENUE are stubbed: they call PublicVesting but
 *    tx.sender = this executor, not the user. PublicVesting identifies
 *    beneficiaries by tx.sender, so these actions are no-ops for the user's
 *    schedule. Users call release()/claimRevenue() directly from their wallets.
 *  • All security features (sig, nonce, deadline, risk guards, throttle)
 *    work for all action types — the limitation is purely dispatch-level.
 *  • Production fix: add releaseFor(beneficiary) to a future PublicVesting.
 */
@final
export class VibeVestAIExecutor extends OP_NET {
    // ─── Action constants ────────────────────────────────────────────────
    private static readonly ACTION_DEPOSIT_AND_VEST: u256 = u256.Zero;
    private static readonly ACTION_RELEASE: u256 = u256.One;
    private static readonly ACTION_CLAIM_REVENUE: u256 = u256.fromU32(2);

    // ─── OP20 method selectors ───────────────────────────────────────────
    private static readonly TRANSFER_FROM_SELECTOR: u32 = encodeSelector(
        'transferFrom(address,address,uint256)',
    );
    private static readonly APPROVE_SELECTOR: u32 = encodeSelector('approve(address,uint256)');

    // ─── PublicVesting method selectors ──────────────────────────────────
    private static readonly DEPOSIT_AND_VEST_SELECTOR: u32 = encodeSelector(
        'depositAndVest(uint256,address,uint256,uint256)',
    );
    private static readonly RELEASE_SELECTOR: u32 = encodeSelector('release()');
    private static readonly CLAIM_REVENUE_SELECTOR: u32 = encodeSelector('claimRevenue()');
    private static readonly GET_CLAIMABLE_REVENUE_SELECTOR: u32 = encodeSelector(
        'getClaimableRevenue(address)',
    );

    /** Blocks per day (~10 min blocks on Bitcoin). */
    private static readonly BLOCKS_PER_DAY: u256 = u256.fromU32(144);

    // ─── Domain separator tag for intent digest ──────────────────────────
    // "VibeVestAIExecutor_v1" as UTF-8 bytes, used in keccak256 domain separation.
    private static readonly DOMAIN_TAG: string = 'VibeVestAIExecutor_v1';

    // ─── Global storage pointers — strict declaration order ──────────────
    private readonly lockedPointer: u16 = Blockchain.nextPointer;            // reentrancy
    private readonly ownerPointer: u16 = Blockchain.nextPointer;             // contract owner
    private readonly publicVestingPointer: u16 = Blockchain.nextPointer;     // FeeVest address
    private readonly maxAmountPerTxPointer: u16 = Blockchain.nextPointer;    // risk cap
    private readonly globalMinBlocksGapPointer: u16 = Blockchain.nextPointer; // global throttle
    private readonly nextNoncePointer: u16 = Blockchain.nextPointer;         // user → nonce
    private readonly lastExecutedBlockPointer: u16 = Blockchain.nextPointer; // user → block
    private readonly allowedTokenPointer: u16 = Blockchain.nextPointer;      // token → 0/1

    // ─── Persistent reentrancy lock ──────────────────────────────────────
    private readonly _locked: StoredBoolean = new StoredBoolean(this.lockedPointer, false);

    // ─── Global state ────────────────────────────────────────────────────
    private readonly _owner: StoredAddress = new StoredAddress(this.ownerPointer);
    private readonly _publicVesting: StoredAddress = new StoredAddress(this.publicVestingPointer);
    private readonly _maxAmountPerTx: StoredU256 = new StoredU256(
        this.maxAmountPerTxPointer,
        EMPTY_POINTER,
    );
    private readonly _globalMinBlocksGap: StoredU256 = new StoredU256(
        this.globalMinBlocksGapPointer,
        EMPTY_POINTER,
    );

    // ─── Per-user maps ───────────────────────────────────────────────────
    private readonly _nextNonce: AddressMemoryMap = new AddressMemoryMap(this.nextNoncePointer);
    private readonly _lastExecutedBlock: AddressMemoryMap = new AddressMemoryMap(
        this.lastExecutedBlockPointer,
    );
    private readonly _allowedToken: AddressMemoryMap = new AddressMemoryMap(
        this.allowedTokenPointer,
    );

    public constructor() {
        super();
    }

    /**
     * Deployment hook — sets deployer as owner.
     * PublicVesting address is set via initialize() due to OPNet testnet calldata bug.
     */
    public override onDeployment(_calldata: Calldata): void {
        this._owner.value = Blockchain.tx.sender;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ADMIN — owner-only setup and configuration
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * One-time initialization: sets the PublicVesting contract address.
     * Must be called after deployment before any executeIntent() call.
     */
    @method({ name: 'publicVesting', type: ABIDataTypes.ADDRESS })
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public initialize(calldata: Calldata): BytesWriter {
        this.onlyOwner();

        if (!this._publicVesting.value.isZero()) {
            throw new Revert('Executor: already initialized');
        }

        const publicVesting: Address = calldata.readAddress();
        if (publicVesting.isZero()) {
            throw new Revert('Executor: publicVesting is zero address');
        }

        this._publicVesting.value = publicVesting;

        const writer = new BytesWriter(1);
        writer.writeBoolean(true);
        return writer;
    }

    /**
     * Updates the PublicVesting address. Owner-only, for migration scenarios.
     */
    @method({ name: 'newPublicVesting', type: ABIDataTypes.ADDRESS })
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public setPublicVesting(calldata: Calldata): BytesWriter {
        this.onlyOwner();

        const newAddr: Address = calldata.readAddress();
        if (newAddr.isZero()) {
            throw new Revert('Executor: zero address');
        }

        this._publicVesting.value = newAddr;

        this.emitEvent(new PublicVestingUpdatedEvent(newAddr));

        const writer = new BytesWriter(1);
        writer.writeBoolean(true);
        return writer;
    }

    /**
     * Sets risk parameters. Owner-only.
     * @param maxAmountPerTx   Maximum token amount per single DEPOSIT_AND_VEST intent.
     * @param globalMinBlocksGap  Minimum blocks between executions for any user.
     */
    @method(
        { name: 'maxAmountPerTx', type: ABIDataTypes.UINT256 },
        { name: 'globalMinBlocksGap', type: ABIDataTypes.UINT256 },
    )
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public setRiskParams(calldata: Calldata): BytesWriter {
        this.onlyOwner();

        const maxAmount: u256 = calldata.readU256();
        const minGap: u256 = calldata.readU256();

        this._maxAmountPerTx.value = maxAmount;
        this._globalMinBlocksGap.value = minGap;

        this.emitEvent(new RiskParamsUpdatedEvent(maxAmount, minGap));

        const writer = new BytesWriter(1);
        writer.writeBoolean(true);
        return writer;
    }

    /**
     * Toggles a token on/off the allowlist for DEPOSIT_AND_VEST actions.
     * @param token    Token address.
     * @param allowed  1 = allowed, 0 = disallowed (u256 encoding of bool).
     */
    @method(
        { name: 'token', type: ABIDataTypes.ADDRESS },
        { name: 'allowed', type: ABIDataTypes.UINT256 },
    )
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public setAllowedToken(calldata: Calldata): BytesWriter {
        this.onlyOwner();

        const token: Address = calldata.readAddress();
        const allowed: u256 = calldata.readU256();

        if (token.isZero()) {
            throw new Revert('Executor: token is zero address');
        }

        this._allowedToken.set(token, allowed);

        this.emitEvent(new AllowedTokenUpdatedEvent(token, allowed));

        const writer = new BytesWriter(1);
        writer.writeBoolean(true);
        return writer;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // CORE — intent execution
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Executes a signed user intent. Any relayer can call this.
     *
     * Intent fields are read sequentially from calldata, followed by a
     * SchnorrSignature (ExtendedAddress + 64-byte sig) read via native
     * readSchnorrSignature(). The signature is verified against a
     * keccak256 domain-separated digest of all intent fields.
     *
     * Validation order (CEI):
     *   1. Read all intent fields + signature from calldata
     *   2. Verify Schnorr signature over domain-separated digest
     *   3. Block deadline check
     *   4. Nonce check (strict sequential)
     *   5. Risk guards (maxAmountPerTx, allowedToken)
     *   6. Throttle (globalMinBlocksGap, intent.minBlocksGap)
     *   7. Condition (minClaimable check via PublicVesting view)
     *   8. Effects: update nonce + lastExecutedBlock
     *   9. Interaction: dispatch action to PublicVesting
     *
     * @param user           The intent signer's address.
     * @param action         0=DEPOSIT_AND_VEST, 1=RELEASE, 2=CLAIM_REVENUE.
     * @param token          Token address (DEPOSIT_AND_VEST only).
     * @param amount         Token amount (DEPOSIT_AND_VEST only).
     * @param beneficiary    Vesting beneficiary (DEPOSIT_AND_VEST only).
     * @param durationDays   Vesting duration in days (DEPOSIT_AND_VEST only).
     * @param minClaimable   Minimum claimable revenue condition (0 = skip).
     * @param minBlocksGap   Per-user throttle hint in blocks.
     * @param nonce          Must equal nextNonce[user].
     * @param deadline       Block number deadline (inclusive).
     *
     * After the 10 declared fields, the calldata must contain a SchnorrSignature
     * (ExtendedAddress 64 bytes + signature 64 bytes = 128 bytes).
     */
    @method(
        { name: 'user', type: ABIDataTypes.ADDRESS },
        { name: 'action', type: ABIDataTypes.UINT256 },
        { name: 'token', type: ABIDataTypes.ADDRESS },
        { name: 'amount', type: ABIDataTypes.UINT256 },
        { name: 'beneficiary', type: ABIDataTypes.ADDRESS },
        { name: 'durationDays', type: ABIDataTypes.UINT256 },
        { name: 'minClaimable', type: ABIDataTypes.UINT256 },
        { name: 'minBlocksGap', type: ABIDataTypes.UINT256 },
        { name: 'nonce', type: ABIDataTypes.UINT256 },
        { name: 'deadline', type: ABIDataTypes.UINT256 },
    )
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public executeIntent(calldata: Calldata): BytesWriter {
        this.nonReentrant();
        this.requireInitialized();

        // ── READ INTENT FIELDS ───────────────────────────────────────────────
        const user: Address = calldata.readAddress();
        const action: u256 = calldata.readU256();
        const token: Address = calldata.readAddress();
        const amount: u256 = calldata.readU256();
        const beneficiary: Address = calldata.readAddress();
        const durationDays: u256 = calldata.readU256();
        const minClaimable: u256 = calldata.readU256();
        const minBlocksGap: u256 = calldata.readU256();
        const nonce: u256 = calldata.readU256();
        const deadline: u256 = calldata.readU256();

        // ── READ SIGNATURE ───────────────────────────────────────────────────
        // SchnorrSignature = ExtendedAddress (64 bytes) + sig (64 bytes)
        const schnorrSig: SchnorrSignature = calldata.readSchnorrSignature();

        // ── 1. SIGNATURE VERIFICATION ────────────────────────────────────────
        const digest: Uint8Array = this.computeIntentDigest(
            user, action, token, amount, beneficiary,
            durationDays, minClaimable, minBlocksGap, nonce, deadline,
        );

        const sigValid: bool = Blockchain.verifySignature(
            schnorrSig.address,
            schnorrSig.signature,
            digest,
        );
        if (!sigValid) {
            throw new Revert('Executor: invalid signature');
        }

        // Verify the signer matches the intent user.
        // ExtendedAddress extends Address — equals() compares the 32-byte key hash.
        if (!schnorrSig.address.equals(user)) {
            throw new Revert('Executor: signer does not match intent user');
        }

        // ── 2. DEADLINE ──────────────────────────────────────────────────────
        const currentBlock: u256 = Blockchain.block.numberU256;
        if (u256.gt(currentBlock, deadline)) {
            throw new Revert('Executor: intent expired');
        }

        // ── 3. NONCE ─────────────────────────────────────────────────────────
        const expectedNonce: u256 = this._nextNonce.get(user);
        if (!u256.eq(nonce, expectedNonce)) {
            throw new Revert('Executor: invalid nonce');
        }

        // ── 4. RISK GUARDS ───────────────────────────────────────────────────
        if (u256.eq(action, VibeVestAIExecutor.ACTION_DEPOSIT_AND_VEST)) {
            // 4a. Max amount per tx
            const maxAmount: u256 = this._maxAmountPerTx.value;
            if (u256.gt(maxAmount, u256.Zero) && u256.gt(amount, maxAmount)) {
                throw new Revert('Executor: amount exceeds maxAmountPerTx');
            }

            // 4b. Token allowlist
            const tokenAllowed: u256 = this._allowedToken.get(token);
            if (u256.eq(tokenAllowed, u256.Zero)) {
                throw new Revert('Executor: token not allowed');
            }
        }

        // ── 5. THROTTLE ──────────────────────────────────────────────────────
        const globalGap: u256 = this._globalMinBlocksGap.value;
        const effectiveGap: u256 = u256.gt(globalGap, minBlocksGap) ? globalGap : minBlocksGap;

        const lastBlock: u256 = this._lastExecutedBlock.get(user);
        if (u256.gt(lastBlock, u256.Zero)) {
            const elapsed: u256 = SafeMath.sub(currentBlock, lastBlock);
            if (u256.lt(elapsed, effectiveGap)) {
                throw new Revert('Executor: throttled');
            }
        }

        // ── 6. CONDITION ─────────────────────────────────────────────────────
        if (u256.gt(minClaimable, u256.Zero)) {
            const claimable: u256 = this.callGetClaimableRevenue(user);
            if (u256.lt(claimable, minClaimable)) {
                throw new Revert('Executor: minClaimable condition not met');
            }
        }

        // ── EFFECTS ──────────────────────────────────────────────────────────
        this._nextNonce.set(user, SafeMath.add(expectedNonce, u256.One));
        this._lastExecutedBlock.set(user, currentBlock);

        // ── INTERACTION ──────────────────────────────────────────────────────
        if (u256.eq(action, VibeVestAIExecutor.ACTION_DEPOSIT_AND_VEST)) {
            this.executeDepositAndVest(user, token, amount, beneficiary, durationDays);
        } else if (u256.eq(action, VibeVestAIExecutor.ACTION_RELEASE)) {
            this.executeRelease();
        } else if (u256.eq(action, VibeVestAIExecutor.ACTION_CLAIM_REVENUE)) {
            this.executeClaimRevenue();
        } else {
            throw new Revert('Executor: unknown action');
        }

        this.emitEvent(new IntentExecutedEvent(
            user, action, token, amount, beneficiary, durationDays, Blockchain.tx.sender,
        ));
        this.releaseGuard();

        const writer = new BytesWriter(1);
        writer.writeBoolean(true);
        return writer;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════════

    /** Returns (maxAmountPerTx, globalMinBlocksGap). */
    @method()
    @returns(
        { name: 'maxAmountPerTx', type: ABIDataTypes.UINT256 },
        { name: 'globalMinBlocksGap', type: ABIDataTypes.UINT256 },
    )
    public getRiskParams(calldata: Calldata): BytesWriter {
        const writer = new BytesWriter(32 * 2);
        writer.writeU256(this._maxAmountPerTx.value);
        writer.writeU256(this._globalMinBlocksGap.value);
        return writer;
    }

    /** Returns the last block at which an intent was executed for a user. */
    @method({ name: 'user', type: ABIDataTypes.ADDRESS })
    @returns({ name: 'blockNumber', type: ABIDataTypes.UINT256 })
    public getLastExecutedBlock(calldata: Calldata): BytesWriter {
        const user: Address = calldata.readAddress();

        const writer = new BytesWriter(32);
        writer.writeU256(this._lastExecutedBlock.get(user));
        return writer;
    }

    /** Returns the next expected nonce for a user. */
    @method({ name: 'user', type: ABIDataTypes.ADDRESS })
    @returns({ name: 'nonce', type: ABIDataTypes.UINT256 })
    public getNextNonce(calldata: Calldata): BytesWriter {
        const user: Address = calldata.readAddress();

        const writer = new BytesWriter(32);
        writer.writeU256(this._nextNonce.get(user));
        return writer;
    }

    /** Returns 1 if token is allowed, 0 otherwise. */
    @method({ name: 'token', type: ABIDataTypes.ADDRESS })
    @returns({ name: 'allowed', type: ABIDataTypes.UINT256 })
    public isTokenAllowed(calldata: Calldata): BytesWriter {
        const token: Address = calldata.readAddress();

        const writer = new BytesWriter(32);
        writer.writeU256(this._allowedToken.get(token));
        return writer;
    }

    /** Returns the PublicVesting contract address. */
    @method()
    @returns({ name: 'publicVesting', type: ABIDataTypes.ADDRESS })
    public getPublicVesting(calldata: Calldata): BytesWriter {
        const writer = new BytesWriter(32);
        writer.writeAddress(this._publicVesting.value);
        return writer;
    }

    /** Returns the contract owner. */
    @method()
    @returns({ name: 'ownerAddress', type: ABIDataTypes.ADDRESS })
    public owner(calldata: Calldata): BytesWriter {
        const writer = new BytesWriter(32);
        writer.writeAddress(this._owner.value);
        return writer;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // INTERNAL — reentrancy, auth, digest, dispatch
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Acquires the reentrancy lock.
     * Uses persistent StoredBoolean — safe against cross-contract re-entry.
     */
    private nonReentrant(): void {
        if (this._locked.value) {
            throw new Revert('Executor: reentrant call');
        }
        this._locked.value = true;
    }

    /** Releases the reentrancy lock. Called at end of every guarded method. */
    private releaseGuard(): void {
        this._locked.value = false;
    }

    /** Reverts if caller is not the contract owner. */
    private onlyOwner(): void {
        if (!Blockchain.tx.sender.equals(this._owner.value)) {
            throw new Revert('Executor: caller is not owner');
        }
    }

    /** Reverts if initialize() has not been called. */
    private requireInitialized(): void {
        if (this._publicVesting.value.isZero()) {
            throw new Revert('Executor: not initialized');
        }
    }

    /**
     * Computes the keccak256 digest of an intent with domain separation.
     *
     * Domain layout (deterministic, tightly packed):
     *   keccak256(
     *     DOMAIN_TAG_BYTES ||
     *     this_contract_address ||
     *     publicVesting_address ||
     *     user || action || token || amount || beneficiary ||
     *     durationDays || minClaimable || minBlocksGap || nonce || deadline
     *   )
     *
     * All addresses are written as 32-byte padded values (writeAddress).
     * All u256 values are 32 bytes.
     */
    private computeIntentDigest(
        user: Address,
        action: u256,
        token: Address,
        amount: u256,
        beneficiary: Address,
        durationDays: u256,
        minClaimable: u256,
        minBlocksGap: u256,
        nonce: u256,
        deadline: u256,
    ): Uint8Array {
        // Domain tag bytes
        const tagBytes: Uint8Array = Uint8Array.wrap(
            String.UTF8.encode(VibeVestAIExecutor.DOMAIN_TAG),
        );

        // Total size: tag + 2 addresses (domain) + 3 addresses (intent) + 7 u256
        // = tagLen + (5 * 32) + (7 * 32) = tagLen + 384
        const totalSize: i32 = tagBytes.length + 32 + 32 + 32 + 32 + 32 + 32 + 32 + 32 + 32 + 32 + 32 + 32;
        const writer = new BytesWriter(totalSize);

        // Domain separator
        writer.writeBytes(tagBytes);
        writer.writeAddress(Blockchain.contractAddress);
        writer.writeAddress(this._publicVesting.value);

        // Intent fields
        writer.writeAddress(user);
        writer.writeU256(action);
        writer.writeAddress(token);
        writer.writeU256(amount);
        writer.writeAddress(beneficiary);
        writer.writeU256(durationDays);
        writer.writeU256(minClaimable);
        writer.writeU256(minBlocksGap);
        writer.writeU256(nonce);
        writer.writeU256(deadline);

        // Hash the packed data
        return keccak256(writer.getBuffer());
    }

    // ─── Action dispatchers ──────────────────────────────────────────────

    /**
     * DEPOSIT_AND_VEST flow:
     *   1. transferFrom(user → this executor, amount) on token
     *   2. approve(publicVesting, amount) on token
     *   3. call PublicVesting.depositAndVest(amount, beneficiary, 0, durationBlocks)
     *   4. reset approval to 0
     *
     * The user must have pre-approved this executor for `amount` on the token.
     */
    private executeDepositAndVest(
        user: Address,
        token: Address,
        amount: u256,
        beneficiary: Address,
        durationDays: u256,
    ): void {
        if (token.isZero()) {
            throw new Revert('Executor: token is zero address');
        }
        if (u256.eq(amount, u256.Zero)) {
            throw new Revert('Executor: amount is zero');
        }
        if (beneficiary.isZero()) {
            throw new Revert('Executor: beneficiary is zero address');
        }
        if (u256.eq(durationDays, u256.Zero)) {
            throw new Revert('Executor: durationDays is zero');
        }

        const vestingAddr: Address = this._publicVesting.value;

        // Convert days to blocks
        const durationBlocks: u256 = SafeMath.mul(durationDays, VibeVestAIExecutor.BLOCKS_PER_DAY);

        // 1. Pull tokens from user to executor
        this.callTokenTransferFrom(token, user, Blockchain.contractAddress, amount);

        // 2. Approve PublicVesting to spend executor's tokens
        this.callTokenApprove(token, vestingAddr, amount);

        // 3. Call PublicVesting.depositAndVest(amount, beneficiary, cliff=0, durationBlocks)
        this.callVestingDepositAndVest(vestingAddr, amount, beneficiary, u256.Zero, durationBlocks);

        // 4. Reset approval to 0 (defense in depth)
        this.callTokenApprove(token, vestingAddr, u256.Zero);
    }

    /**
     * RELEASE: calls PublicVesting.release().
     * ⚠ Limitation: releases for tx.sender = this executor, not the user.
     */
    private executeRelease(): void {
        const vestingAddr: Address = this._publicVesting.value;

        const callWriter = new BytesWriter(4);
        callWriter.writeSelector(VibeVestAIExecutor.RELEASE_SELECTOR);

        const result: CallResult = Blockchain.call(vestingAddr, callWriter, true);
        if (result.data.byteLength > 0) {
            // release() returns a u256 (released amount) — we don't need to check it
        }
    }

    /**
     * CLAIM_REVENUE: calls PublicVesting.claimRevenue().
     * ⚠ Limitation: claims for tx.sender = this executor, not the user.
     */
    private executeClaimRevenue(): void {
        const vestingAddr: Address = this._publicVesting.value;

        const callWriter = new BytesWriter(4);
        callWriter.writeSelector(VibeVestAIExecutor.CLAIM_REVENUE_SELECTOR);

        const result: CallResult = Blockchain.call(vestingAddr, callWriter, true);
        if (result.data.byteLength > 0) {
            // claimRevenue() returns a u256 (claimed amount)
        }
    }

    // ─── Cross-contract call helpers ─────────────────────────────────────

    /**
     * OP20 transferFrom(from, to, amount).
     * Caller (this executor) must be approved by `from`.
     */
    private callTokenTransferFrom(
        token: Address,
        from: Address,
        to: Address,
        amount: u256,
    ): void {
        const callWriter = new BytesWriter(4 + 32 + 32 + 32);
        callWriter.writeSelector(VibeVestAIExecutor.TRANSFER_FROM_SELECTOR);
        callWriter.writeAddress(from);
        callWriter.writeAddress(to);
        callWriter.writeU256(amount);

        const result: CallResult = Blockchain.call(token, callWriter, true);
        if (result.data.byteLength > 0) {
            if (!result.data.readBoolean()) {
                throw new Revert('Executor: token transferFrom failed');
            }
        }
    }

    /** OP20 approve(spender, amount). */
    private callTokenApprove(token: Address, spender: Address, amount: u256): void {
        const callWriter = new BytesWriter(4 + 32 + 32);
        callWriter.writeSelector(VibeVestAIExecutor.APPROVE_SELECTOR);
        callWriter.writeAddress(spender);
        callWriter.writeU256(amount);

        const result: CallResult = Blockchain.call(token, callWriter, true);
        if (result.data.byteLength > 0) {
            if (!result.data.readBoolean()) {
                throw new Revert('Executor: token approve failed');
            }
        }
    }

    /**
     * Calls PublicVesting.depositAndVest(amount, beneficiary, cliffDuration, vestingDuration).
     */
    private callVestingDepositAndVest(
        vesting: Address,
        amount: u256,
        beneficiary: Address,
        cliffDuration: u256,
        vestingDuration: u256,
    ): void {
        const callWriter = new BytesWriter(4 + 32 + 32 + 32 + 32);
        callWriter.writeSelector(VibeVestAIExecutor.DEPOSIT_AND_VEST_SELECTOR);
        callWriter.writeU256(amount);
        callWriter.writeAddress(beneficiary);
        callWriter.writeU256(cliffDuration);
        callWriter.writeU256(vestingDuration);

        const result: CallResult = Blockchain.call(vesting, callWriter, true);
        if (result.data.byteLength > 0) {
            if (!result.data.readBoolean()) {
                throw new Revert('Executor: depositAndVest failed');
            }
        }
    }

    /**
     * Calls PublicVesting.getClaimableRevenue(beneficiary) — view call.
     * Returns the claimable revenue amount for the given address.
     */
    private callGetClaimableRevenue(user: Address): u256 {
        const callWriter = new BytesWriter(4 + 32);
        callWriter.writeSelector(VibeVestAIExecutor.GET_CLAIMABLE_REVENUE_SELECTOR);
        callWriter.writeAddress(user);

        const result: CallResult = Blockchain.call(this._publicVesting.value, callWriter, true);
        if (result.data.byteLength >= 32) {
            return result.data.readU256();
        }

        return u256.Zero;
    }
}
