import { app } from 'electron';
import { machineIdSync } from 'node-machine-id';
import { ensureSystemBinPathForMachineId } from './deviceId';

export function resolveProductDeviceId(
  rawMachineId: string,
  isPackagedLex: boolean,
  override: string | undefined,
): string {
  return override ?? (isPackagedLex ? `lex-${rawMachineId.slice(0, 60)}` : rawMachineId);
}

export function usesLexDeviceIdentity(): boolean {
  return (
    app.isPackaged && app.getName() === 'Lex' && process.env.XDT_DEVICE_ID_OVERRIDE === undefined
  );
}

let deviceId: string | undefined;

export function getProductDeviceId(): string {
  if (deviceId === undefined) {
    ensureSystemBinPathForMachineId();
    deviceId =
      process.env.XDT_DEVICE_ID_OVERRIDE ??
      resolveProductDeviceId(machineIdSync(), app.isPackaged && app.getName() === 'Lex', undefined);
  }
  return deviceId;
}

export function deviceCredentialKey(key: string): string {
  return usesLexDeviceIdentity() ? `lex_device_v1_${key}` : key;
}
