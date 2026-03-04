import { u256 } from '@btc-vision/as-bignum/assembly';
import {
    Address,
    Blockchain,
    BytesWriter,
    Calldata,
    OP20,
    OP20InitParameters,
    Revert,
} from '@btc-vision/btc-runtime/runtime';

/**
 * FeeToken — Minimal OP_20 token for FeeVest testing on OPNet Testnet.
 *
 * ⚠️  NOT for production use. This is a test/mock token only.
 *
 * Hardcoded parameters avoid the known OPNet testnet onDeploy() bug
 * (0-byte calldata delivery), so the token is ready to use immediately
 * after deployment without a separate initialize() step.
 *
 * Deployer can mint freely via mint(to, amount).
 */
@final
export class FeeToken extends OP20 {
    public constructor() {
        super();
    }

    /**
     * Deployment hook — initializes token parameters once.
     * All params are hardcoded to avoid the testnet onDeploy() 0-byte calldata bug.
     */
    public override onDeployment(_calldata: Calldata): void {
        this.instantiate(
            new OP20InitParameters(
                u256.fromString('1000000000000000000000000000'), // 1 billion × 1e18
                18,
                'Fee Token',
                'FEE',
            ),
            true, // skip deployer check — called from deployment context
        );
    }

    /**
     * Mints tokens to any address.
     * Restricted to the original deployer only.
     *
     * @param to     Recipient address.
     * @param amount Token amount in base units (1 FEE = 1e18).
     */
    @method(
        { name: 'to', type: ABIDataTypes.ADDRESS },
        { name: 'amount', type: ABIDataTypes.UINT256 },
    )
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public mint(calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);

        const to: Address = calldata.readAddress();
        const amount: u256 = calldata.readU256();

        if (to.isZero()) {
            throw new Revert('FeeToken: mint to zero address');
        }
        if (u256.eq(amount, u256.Zero)) {
            throw new Revert('FeeToken: amount is zero');
        }

        this._mint(to, amount);

        const writer = new BytesWriter(1);
        writer.writeBoolean(true);
        return writer;
    }
}
