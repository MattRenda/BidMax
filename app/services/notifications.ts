import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

// EAS project id (also in app.json extra.eas.projectId) — needed to mint an Expo
// push token in release builds.
const PROJECT_ID = 'd4cbd839-f0e3-491d-a6de-800e71300c4a';

// Show alerts while the app is foregrounded.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

// Request permission + return an Expo push token (or null if denied/unavailable).
// Call this only when the user opts into alerts — don't prompt on first launch.
export async function registerForPushNotificationsAsync(): Promise<string | null> {
  try {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'Default',
        importance: Notifications.AndroidImportance.DEFAULT,
      });
    }
    const existing = await Notifications.getPermissionsAsync();
    let status = existing.status;
    if (status !== 'granted') {
      status = (await Notifications.requestPermissionsAsync()).status;
    }
    if (status !== 'granted') return null;
    const token = await Notifications.getExpoPushTokenAsync({ projectId: PROJECT_ID });
    return token.data;
  } catch {
    return null;
  }
}
