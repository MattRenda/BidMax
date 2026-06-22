// Centralized theme palettes for BidMax. Dark mode reads like a pro trading
// terminal; light mode reads like a clean financial app for outdoor glare.
// The profit-green / hot-amber / loss-red accents carry across both modes.

export type ColorScheme = 'light' | 'dark';
export type ThemeMode = 'light' | 'dark';

export interface Palette {
  scheme: ColorScheme;
  bg: string;
  surface: string;
  surface2: string;
  border: string;
  text: string;
  muted: string;
  green: string;
  greenDim: string;
  greenGlow: string;
  amber: string;
  amberDim: string;
  amberGlow: string;
  red: string;
  redDim: string;
  onPrimary: string; // text/icon color on a green or amber fill
}

export const darkColors: Palette = {
  scheme: 'dark',
  bg: '#080d14',
  surface: '#0d1520',
  surface2: '#111d2e',
  border: '#1a2d42',
  text: '#e2e8f0',
  muted: '#64748b',
  green: '#22c55e',
  greenDim: 'rgba(34,197,94,0.12)',
  greenGlow: 'rgba(34,197,94,0.45)',
  amber: '#f59e0b',
  amberDim: 'rgba(245,158,11,0.14)',
  amberGlow: 'rgba(245,158,11,0.5)',
  red: '#ef4444',
  redDim: 'rgba(239,68,68,0.12)',
  onPrimary: '#04140a',
};

export const lightColors: Palette = {
  scheme: 'light',
  bg: '#f8fafc',
  surface: '#ffffff',
  surface2: '#f1f5f9',
  border: '#e2e8f0',
  text: '#0f172a',
  muted: '#64748b',
  // Slightly deeper accents so colored numbers stay legible on white.
  green: '#16a34a',
  greenDim: 'rgba(22,163,74,0.10)',
  greenGlow: 'rgba(22,163,74,0.28)',
  amber: '#d97706',
  amberDim: 'rgba(217,119,6,0.12)',
  amberGlow: 'rgba(217,119,6,0.32)',
  red: '#dc2626',
  redDim: 'rgba(220,38,38,0.10)',
  onPrimary: '#ffffff',
};

export const palettes: Record<ColorScheme, Palette> = {
  dark: darkColors,
  light: lightColors,
};
