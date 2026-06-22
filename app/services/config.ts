const DEV_SERVER = 'https://bidmax-development.up.railway.app';
const PROD_SERVER = 'https://bidmax-production.up.railway.app';

// Resolve per build: explicit EXPO_PUBLIC_SERVER_URL wins; otherwise prod for
// release builds and the dev server while running in Metro (__DEV__).
export const SERVER_URL = process.env.EXPO_PUBLIC_SERVER_URL || (__DEV__ ? DEV_SERVER : PROD_SERVER);

export const FREE_DAILY_LIMIT = 10;
