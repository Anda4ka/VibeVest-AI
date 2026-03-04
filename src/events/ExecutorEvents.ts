import { u256 } from '@btc-vision/as-bignum/assembly';
import { Address, BytesWriter, NetEvent } from '@btc-vision/btc-runtime/runtime';

/**
 * Emitted after a signed intent is successfully executed.
 * `relayer` is Blockchain.tx.sender — the address that submitted the transaction.
 */
export class IntentExecutedEvent extends NetEvent {
    constructor(
        user: Address,
        action: u256,
        token: Address,
        amount: u256,
        beneficiary: Address,
        durationDays: u256,
        relayer: Address,
    ) {
        const writer = new BytesWriter(32 * 7);
        writer.writeAddress(user);
        writer.writeU256(action);
        writer.writeAddress(token);
        writer.writeU256(amount);
        writer.writeAddress(beneficiary);
        writer.writeU256(durationDays);
        writer.writeAddress(relayer);
        super('IntentExecuted', writer);
    }
}

/** Emitted when the owner updates risk parameters. */
export class RiskParamsUpdatedEvent extends NetEvent {
    constructor(maxAmountPerTx: u256, globalMinBlocksGap: u256) {
        const writer = new BytesWriter(32 * 2);
        writer.writeU256(maxAmountPerTx);
        writer.writeU256(globalMinBlocksGap);
        super('RiskParamsUpdated', writer);
    }
}

/** Emitted when the owner toggles a token's allowlist status. */
export class AllowedTokenUpdatedEvent extends NetEvent {
    constructor(token: Address, allowed: u256) {
        const writer = new BytesWriter(32 + 32);
        writer.writeAddress(token);
        writer.writeU256(allowed);
        super('AllowedTokenUpdated', writer);
    }
}

/** Emitted when the owner updates the PublicVesting contract address. */
export class PublicVestingUpdatedEvent extends NetEvent {
    constructor(newAddress: Address) {
        const writer = new BytesWriter(32);
        writer.writeAddress(newAddress);
        super('PublicVestingUpdated', writer);
    }
}
