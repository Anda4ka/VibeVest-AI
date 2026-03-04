import { Blockchain } from '@btc-vision/btc-runtime/runtime';
import { FeeVest } from './FeeVest';
import { revertOnError } from '@btc-vision/btc-runtime/runtime/abort/abort';

// 1. Factory function — REQUIRED
//    Returns a new FeeVest instance on every call frame.
Blockchain.contract = (): FeeVest => {
    return new FeeVest();
};

// 2. Runtime exports — REQUIRED
//    Exports `execute`, `onDeploy`, `onUpdate` entry functions to the WASM VM.
export * from '@btc-vision/btc-runtime/runtime/exports/index';

// 3. Abort handler — REQUIRED
//    Converts AssemblyScript runtime panics into clean OPNet reverts.
export function abort(message: string, fileName: string, line: u32, column: u32): void {
    revertOnError(message, fileName, line, column);
}
