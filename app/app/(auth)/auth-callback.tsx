import { View, ActivityIndicator } from 'react-native';
import { useTheme } from '../../hooks/useTheme';

// The OAuth redirect (bidmax://auth-callback?sessionToken=...) deep-links here.
// The token is actually captured in the sign-in screen via
// WebBrowser.openAuthSessionAsync, which then routes to the tabs. This screen
// exists only so expo-router renders a clean spinner during the brief hand-off
// instead of flashing its "Unmatched Route" page. Living inside the (auth) group
// also keeps the auth gate in app/_layout.tsx from bouncing it to sign-in.
export default function AuthCallback() {
  const { colors } = useTheme();
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' }}>
      <ActivityIndicator color={colors.green} size="large" />
    </View>
  );
}
