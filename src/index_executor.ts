import { Blockchain } from '@btc-vision/btc-runtime/runtime';
import { VibeVestAIExecutor } from './VibeVestAIExecutor';
import { revertOnError } from '@btc-vision/btc-runtime/runtime/abort/abort';

// 1. Factory function — REQUIRED by OPNet runtime
Blockchain.contract = (): VibeVestAIExecutor => {
    return new VibeVestAIExecutor();
};

// 2. Runtime exports — REQUIRED
export * from '@btc-vision/btc-runtime/runtime/exports/index';

// 3. Abort handler — converts panics to clean reverts
export function abort(message: string, fileName: string, line: u32, column: u32): void {
    revertOnError(message, fileName, line, column);
}
