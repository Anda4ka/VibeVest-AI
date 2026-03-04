import { u256 } from '@btc-vision/as-bignum/assembly';
import { Address, BytesWriter, NetEvent } from '@btc-vision/btc-runtime/runtime';

/**
 * Emitted when a new vesting schedule is publicly created.
 * `depositor` is msg.sender — the address that funded the vesting (may differ from beneficiary).
 */
export class VestingCreatedEvent extends NetEvent {
    constructor(
        beneficiary: Address,
        amount: u256,
        cliffBlocks: u256,
        durationBlocks: u256,
        depositor: Address,
    ) {
        const writer = new BytesWriter(32 + 32 + 32 + 32 + 32);
        writer.writeAddress(beneficiary);
        writer.writeU256(amount);
        writer.writeU256(cliffBlocks);
        writer.writeU256(durationBlocks);
        writer.writeAddress(depositor);
        super('VestingCreated', writer);
    }
}

/** Emitted when a beneficiary releases vested tokens via release(). */
export class TokensReleasedEvent extends NetEvent {
    constructor(beneficiary: Address, amount: u256) {
        const writer = new BytesWriter(32 + 32);
        writer.writeAddress(beneficiary);
        writer.writeU256(amount);
        super('TokensReleased', writer);
    }
}

/** Emitted when revenue is deposited into the vault for proportional distribution. */
export class RevenueDepositedEvent extends NetEvent {
    constructor(depositor: Address, amount: u256) {
        const writer = new BytesWriter(32 + 32);
        writer.writeAddress(depositor);
        writer.writeU256(amount);
        super('RevenueDeposited', writer);
    }
}

/** Emitted when a beneficiary claims their share of accumulated protocol revenue. */
export class RevenueClaimedEvent extends NetEvent {
    constructor(beneficiary: Address, amount: u256) {
        const writer = new BytesWriter(32 + 32);
        writer.writeAddress(beneficiary);
        writer.writeU256(amount);
        super('RevenueClaimed', writer);
    }
}
