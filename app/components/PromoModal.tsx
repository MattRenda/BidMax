import React, { useState, useMemo, useEffect } from 'react';
import {
  View, Text, StyleSheet, Modal, Pressable, TextInput, TouchableOpacity, ActivityIndicator,
} from 'react-native';
import { useTheme } from '../hooks/useTheme';
import { Palette } from '../services/theme';
import { useAuth } from '../hooks/useAuth';
import { redeemPromo } from '../services/auth';

// Promo-code entry used both at first launch (showSkip) and from Settings.
// Self-contained: pulls the session token + refresh from the auth context.
export function PromoModal({
  visible,
  onClose,
  showSkip = false,
}: {
  visible: boolean;
  onClose: () => void;
  showSkip?: boolean;
}) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { sessionToken, refresh } = useAuth();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [trialEndsAt, setTrialEndsAt] = useState<string | null>(null); // set → success state

  useEffect(() => {
    if (visible) { setCode(''); setBusy(false); setError(null); setTrialEndsAt(null); }
  }, [visible]);

  const activate = async () => {
    if (busy) return;
    if (!sessionToken) { setError('Please sign in first to redeem a code.'); return; }
    const trimmed = code.trim();
    if (!trimmed) { setError('Enter a promo code.'); return; }
    setBusy(true); setError(null);
    try {
      const res = await redeemPromo(sessionToken, trimmed);
      await refresh(); // pull updated is_pro / trial_ends_at into the app
      setTrialEndsAt(res.trialEndsAt);
    } catch (e: any) {
      setError(e?.message || 'Could not redeem this code.');
    } finally {
      setBusy(false);
    }
  };

  const fmt = (iso: string | null) =>
    iso ? new Date(iso).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' }) : '';

  return (
    <Modal visible={visible} transparent animationType="fade" statusBarTranslucent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        {/* tapping outside dismisses entry, but not the success confirmation */}
        <Pressable style={styles.backdropFill} onPress={trialEndsAt ? undefined : onClose} />
        <View style={styles.popup}>
          {trialEndsAt ? (
            <>
              <Text style={styles.bigIcon}>✅</Text>
              <Text style={styles.title}>Pro Trial Activated!</Text>
              <Text style={styles.sub}>30 days free</Text>
              <Text style={styles.expires}>Expires {fmt(trialEndsAt)}</Text>
              <TouchableOpacity style={styles.primaryBtn} onPress={onClose} activeOpacity={0.85}>
                <Text style={styles.primaryBtnText}>Start Exploring</Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              <Text style={styles.bigIcon}>🎉</Text>
              <Text style={styles.title}>Got a promo code?</Text>
              <Text style={styles.sub}>Enter it below for 30 days of free Pro access.</Text>
              <TextInput
                style={styles.input}
                placeholder="Enter code…"
                placeholderTextColor={colors.muted}
                value={code}
                onChangeText={(t) => { setCode(t); if (error) setError(null); }}
                autoCapitalize="characters"
                autoCorrect={false}
                autoFocus
                returnKeyType="done"
                onSubmitEditing={activate}
                editable={!busy}
              />
              {!!error && <Text style={styles.error}>{error}</Text>}
              <TouchableOpacity style={styles.primaryBtn} onPress={activate} disabled={busy} activeOpacity={0.85}>
                {busy ? <ActivityIndicator color={colors.onPrimary} /> : <Text style={styles.primaryBtnText}>Activate</Text>}
              </TouchableOpacity>
              <TouchableOpacity style={styles.skipBtn} onPress={onClose} disabled={busy} activeOpacity={0.7}>
                <Text style={styles.skipText}>{showSkip ? 'Skip for now' : 'Cancel'}</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  backdropFill: { ...StyleSheet.absoluteFillObject },
  popup: { width: '100%', maxWidth: 380, backgroundColor: c.surface, borderRadius: 16, borderWidth: 1, borderColor: c.border, padding: 24, alignItems: 'center' },
  bigIcon: { fontSize: 44, marginBottom: 8 },
  title: { color: c.text, fontSize: 20, fontWeight: '900', textAlign: 'center' },
  sub: { color: c.muted, fontSize: 14, textAlign: 'center', marginTop: 6, lineHeight: 20 },
  expires: { color: c.green, fontSize: 14, fontWeight: '700', textAlign: 'center', marginTop: 8 },
  input: {
    width: '100%', backgroundColor: c.surface2, borderRadius: 12, borderWidth: 1, borderColor: c.border,
    color: c.text, fontSize: 16, fontWeight: '700', letterSpacing: 1, textAlign: 'center',
    paddingVertical: 14, paddingHorizontal: 16, marginTop: 18,
  },
  error: { color: c.red, fontSize: 13, textAlign: 'center', marginTop: 10 },
  primaryBtn: { width: '100%', backgroundColor: c.green, borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginTop: 16 },
  primaryBtnText: { color: c.onPrimary, fontSize: 16, fontWeight: '800' },
  skipBtn: { paddingVertical: 12, marginTop: 4 },
  skipText: { color: c.muted, fontSize: 13, fontWeight: '600' },
});
