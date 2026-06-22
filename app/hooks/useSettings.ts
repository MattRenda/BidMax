import { useSyncExternalStore } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

export interface Settings {
  targetMargin: number;
  buyersPremium: number;
  fireThreshold: number;
  fireAlertsEnabled: boolean;
  bidrlUsername: string;
  selectedAffiliate: string;
  affiliateName: string;
}

const DEFAULTS: Settings = {
  targetMargin: 30,
  buyersPremium: 15,
  fireThreshold: 50,
  fireAlertsEnabled: false,
  bidrlUsername: '',
  selectedAffiliate: '',
  affiliateName: '',
};

const STORAGE_KEY = 'bidmax_settings';

// Module-level shared store so every screen (Deals, Settings, …) reads and
// writes the same settings — changing the ROI on the Settings tab updates the
// already-mounted Deals tab live, without remounting or re-reading storage.
let current: Settings = DEFAULTS;
let loaded = false;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

// Hydrate once from storage on first import.
AsyncStorage.getItem(STORAGE_KEY).then(raw => {
  if (raw) current = { ...DEFAULTS, ...JSON.parse(raw) };
  loaded = true;
  emit();
});

async function save(updates: Partial<Settings>) {
  current = { ...current, ...updates };
  emit();
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(current));
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useSettings() {
  const settings = useSyncExternalStore(subscribe, () => current, () => current);
  return { settings, save, loaded };
}
