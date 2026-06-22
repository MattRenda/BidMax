import React, { useRef, useState } from 'react';
import {
  Modal, View, TouchableOpacity, Text, StyleSheet, ActivityIndicator,
  SafeAreaView, Platform,
} from 'react-native';
import { WebView } from 'react-native-webview';

// Masquerade as a real mobile browser so BidRL doesn't block the WebView.
const USER_AGENT =
  Platform.OS === 'ios'
    ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
    : 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

interface Props {
  url: string;
  lotId: string;
  onClose: () => void;
}

export function BidWebView({ url, lotId, onClose }: Props) {
  const webViewRef = useRef<WebView>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <SafeAreaView style={styles.root}>
        {/* Header bar */}
        <View style={styles.header}>
          <Text style={styles.headerTitle} numberOfLines={1}>
            Bid on BidRL · {lotId}
          </Text>
          <TouchableOpacity onPress={onClose} hitSlop={10} style={styles.closeBtn}>
            <Text style={styles.closeTxt}>✕</Text>
          </TouchableOpacity>
        </View>

        {/* Loading spinner overlay */}
        {loading && !error && (
          <View style={styles.loadingOverlay} pointerEvents="none">
            <ActivityIndicator size="large" color="#22c55e" />
            <Text style={styles.loadingTxt}>Loading BidRL…</Text>
          </View>
        )}

        {/* Error state */}
        {error ? (
          <View style={styles.errorBox}>
            <Text style={styles.errorIcon}>⚠️</Text>
            <Text style={styles.errorTitle}>Couldn't load BidRL</Text>
            <Text style={styles.errorSub}>Check your connection and try again.</Text>
            <TouchableOpacity
              style={styles.retryBtn}
              onPress={() => { setError(false); setLoading(true); webViewRef.current?.reload(); }}
              activeOpacity={0.8}
            >
              <Text style={styles.retryTxt}>Retry</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <WebView
            ref={webViewRef}
            source={{ uri: url }}
            userAgent={USER_AGENT}
            sharedCookiesEnabled
            thirdPartyCookiesEnabled
            javaScriptEnabled
            domStorageEnabled
            onLoadStart={() => setLoading(true)}
            onLoadEnd={() => setLoading(false)}
            onError={() => { setLoading(false); setError(true); }}
            style={styles.webView}
          />
        )}
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0a1628' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1a2d42',
    backgroundColor: '#0d1520',
  },
  headerTitle: { flex: 1, color: '#e2e8f0', fontSize: 14, fontWeight: '700' },
  closeBtn: { marginLeft: 12, padding: 4 },
  closeTxt: { color: '#64748b', fontSize: 18, fontWeight: '700' },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#0a1628',
    zIndex: 10,
  },
  loadingTxt: { color: '#64748b', marginTop: 12, fontSize: 13 },
  webView: { flex: 1, backgroundColor: '#0a1628' },
  errorBox: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  errorIcon: { fontSize: 40, marginBottom: 16 },
  errorTitle: { color: '#e2e8f0', fontSize: 18, fontWeight: '800', marginBottom: 8 },
  errorSub: { color: '#64748b', fontSize: 13, textAlign: 'center', marginBottom: 24 },
  retryBtn: {
    backgroundColor: '#22c55e',
    paddingHorizontal: 28,
    paddingVertical: 12,
    borderRadius: 10,
  },
  retryTxt: { color: '#000', fontWeight: '800', fontSize: 14 },
});
