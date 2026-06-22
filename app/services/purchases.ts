import { Platform } from 'react-native';

// RevenueCat public SDK keys, resolved by build like SERVER_URL — NOT via env,
// so OTA updates (which don't carry eas.json env) and native builds always agree:
// dev → Test Store key; any release build → the real platform key.
const TEST_STORE_KEY = 'test_EZSAZGcXtIOUBqCywWCBMSrUHmB';
const PROD_IOS_KEY = 'appl_ZeBnKpjmQEBzoDZLeytreJmbiax'; // RevenueCat App Store public SDK key
const PROD_ANDROID_KEY = 'goog_wuBHXKzrjguPfWjsEiUILqHsVYi';

const IOS_KEY = process.env.EXPO_PUBLIC_RC_IOS_KEY || (__DEV__ ? TEST_STORE_KEY : PROD_IOS_KEY);
const ANDROID_KEY = process.env.EXPO_PUBLIC_RC_ANDROID_KEY || (__DEV__ ? TEST_STORE_KEY : PROD_ANDROID_KEY);

// Entitlement identifier configured in the RevenueCat dashboard (must match the
// Identifier field exactly — case/space sensitive — not the display name).
export const PRO_ENTITLEMENT = 'BidMax Pro';

// Lazy require so a dev build without the native module doesn't crash at import.
function getSDK(): any | null {
  try { return require('react-native-purchases').default; } catch { return null; }
}

let configured = false;

// A Test Store key must NEVER be used in a release build — the SDK crashes in
// production and the app gets rejected in review. Block it outside dev.
function usableKey(): string {
  const key = Platform.OS === 'ios' ? IOS_KEY : ANDROID_KEY;
  if (!key) return '';
  if (!__DEV__ && key.startsWith('test_')) return '';
  return key;
}

export function purchasesAvailable(): boolean {
  return !!usableKey() && !!getSDK();
}

// Configure once, then tie the RevenueCat customer to the signed-in user so the
// webhook can map purchases back to the right account.
export async function initPurchases(appUserId?: string): Promise<void> {
  const Purchases = getSDK();
  const apiKey = usableKey();
  if (!Purchases || !apiKey) return;
  try {
    if (!configured) {
      Purchases.configure({ apiKey, appUserID: appUserId });
      configured = true;
    } else if (appUserId) {
      await Purchases.logIn(appUserId);
    }
  } catch {}
}

export async function isProEntitled(): Promise<boolean> {
  const Purchases = getSDK();
  if (!Purchases || !configured) return false;
  try {
    const info = await Purchases.getCustomerInfo();
    return !!info.entitlements.active[PRO_ENTITLEMENT];
  } catch {
    return false;
  }
}

export type PurchaseResult = 'success' | 'cancelled';

// Throws a descriptive Error for each failure so the cause is visible on-device.
export async function purchasePro(): Promise<PurchaseResult> {
  const Purchases = getSDK();
  if (!Purchases) throw new Error('Purchases unavailable: native module missing (needs a build with react-native-purchases).');
  if (!configured) throw new Error('Purchases unavailable: RevenueCat not configured (API key missing/invalid for this build).');

  let offerings: any;
  try {
    offerings = await Purchases.getOfferings();
  } catch (e: any) {
    if (e?.userCancelled) return 'cancelled';
    throw e;
  }

  if (!offerings.current) {
    throw new Error('No current Offering in RevenueCat. Mark one Offering as Current/Default and add a package for your product.');
  }
  const pkg = offerings.current.availablePackages?.[0];
  if (!pkg) {
    throw new Error('Offering has no available packages. The Play product isn’t purchasable yet — check it’s Active + propagated, attached to the Offering, and the app is installed from Play.');
  }

  try {
    const { customerInfo } = await Purchases.purchasePackage(pkg);
    if (!customerInfo.entitlements.active[PRO_ENTITLEMENT]) {
      throw new Error(`Purchase completed, but the "${PRO_ENTITLEMENT}" entitlement isn’t attached to this product in RevenueCat.`);
    }
    return 'success';
  } catch (e: any) {
    if (e?.userCancelled) return 'cancelled';
    // The Google Play account already owns this subscription (e.g. it was bought
    // under a different BidMax login on this device). Restore it onto the current
    // user instead of failing — RevenueCat's transfer setting decides ownership.
    const alreadyOwned =
      e?.readableErrorCode === 'ProductAlreadyPurchasedError' ||
      e?.code === 7 || e?.code === '7' ||
      /already/i.test(e?.message || '');
    if (alreadyOwned) {
      try {
        const info = await Purchases.restorePurchases();
        if (info?.entitlements?.active?.[PRO_ENTITLEMENT]) return 'success';
      } catch {}
      throw new Error(
        'This Google Play account already owns the subscription, but it’s linked to a different BidMax account. Tap “Restore Purchases,” or sign in with the original account.'
      );
    }
    throw e;
  }
}

export async function restorePro(): Promise<boolean> {
  const Purchases = getSDK();
  if (!Purchases || !configured) return false;
  try {
    const info = await Purchases.restorePurchases();
    return !!info.entitlements.active[PRO_ENTITLEMENT];
  } catch {
    return false;
  }
}
