import { Blockchain } from '@btc-vision/btc-runtime/runtime';
import { FeeToken } from './token/FeeToken';
import { revertOnError } from '@btc-vision/btc-runtime/runtime/abort/abort';

// Entry point for FeeToken mock token contract.
Blockchain.contract = (): FeeToken => {
    return new FeeToken();
};

export * from '@btc-vision/btc-runtime/runtime/exports/index';

export function abort(message: string, fileName: string, line: u32, column: u32): void {
    revertOnError(message, fileName, line, column);
}
