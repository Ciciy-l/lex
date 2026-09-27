import { createContext, useContext } from 'react';
import type { SettingsSearchEntry } from './settingsSearchTypes';

export const SettingsSearchNavigationContext = createContext<{
  entry: SettingsSearchEntry | null;
  activation: number;
}>({ entry: null, activation: 0 });

export function useSettingsSearchNavigation() {
  return useContext(SettingsSearchNavigationContext);
}
