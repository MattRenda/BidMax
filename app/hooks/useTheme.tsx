import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Palette, ThemeMode, ColorScheme, palettes } from '../services/theme';

interface ThemeContextValue {
  mode: ThemeMode;        // user preference: light or dark
  scheme: ColorScheme;    // the resolved scheme in effect (same as mode)
  colors: Palette;
  setMode: (m: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  mode: 'dark',
  scheme: 'dark',
  colors: palettes.dark,
  setMode: () => {},
});

const STORAGE_KEY = 'bidmax_theme';

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>('dark');

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then(v => {
      if (v === 'light' || v === 'dark') setModeState(v);
    });
  }, []);

  const setMode = (m: ThemeMode) => {
    setModeState(m);
    AsyncStorage.setItem(STORAGE_KEY, m);
  };

  const colors = palettes[mode];
  const value = useMemo(() => ({ mode, scheme: mode, colors, setMode }), [mode, colors]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export const useTheme = () => useContext(ThemeContext);
