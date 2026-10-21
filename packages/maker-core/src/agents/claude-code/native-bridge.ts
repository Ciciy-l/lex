import { NativeSessionBridge, type NativeSessionBridgeOptions } from '../shared/native-session-bridge.js';

export type { NativeBridgeEvent as ClaudeBridgeEvent, NativeBridgeRequest as ClaudeNativeRequest,
  NativeBridgeCommand as ClaudeNativeCommand } from '../shared/native-session-bridge.js';
export type ClaudeNativeBridgeOptions = Omit<NativeSessionBridgeOptions, 'environmentPrefix'>;

/** Claude keeps its existing wire/environment contract over the shared task transport. */
export class ClaudeNativeBridge extends NativeSessionBridge {
  constructor(options: ClaudeNativeBridgeOptions) {
    super({ ...options, environmentPrefix: 'LEX_CLAUDE_BRIDGE' });
  }
}
