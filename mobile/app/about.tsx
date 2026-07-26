import { isLiquidGlassAvailable } from 'expo-glass-effect';
import Constants from 'expo-constants';
import { StatusBar } from 'expo-status-bar';
import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, space } from '../src/theme';

function Row({ k, v }: { k: string; v: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.k}>{k}</Text>
      <Text style={styles.v}>{v}</Text>
    </View>
  );
}

export default function AboutScreen() {
  const insets = useSafeAreaInsets();
  return (
    <View style={styles.screen}>
      <StatusBar style="light" />
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingTop: insets.top + space.lg },
        ]}
        contentInsetAdjustmentBehavior="automatic"
      >
        <Text style={styles.heading}>About</Text>
        <Text style={styles.body}>
          Expo prototype for the LFG native app. The tab bar below is a real
          UIKit UITabBar via expo-router native tabs — not a JS reimplementation
          — which is why it picks up Liquid Glass automatically on iOS 26.
        </Text>

        <View style={styles.card}>
          <Row k="expo sdk" v="57" />
          <Row k="react native" v="0.86" />
          <Row
            k="runtime"
            v={Constants.expoConfig?.sdkVersion ?? 'unknown'}
          />
          <Row k="platform" v={`${Platform.OS} ${String(Platform.Version)}`} />
          <Row k="liquid glass" v={String(isLiquidGlassAvailable())} />
        </View>

        <Text style={styles.note}>
          Tabs: native UITabBar (expo-router){'\n'}
          Glass: expo-glass-effect (UIVisualEffectView){'\n'}
          Storage: AsyncStorage
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { paddingHorizontal: space.lg, paddingBottom: 120 },
  heading: {
    color: colors.text,
    fontSize: 34,
    fontWeight: '800',
    letterSpacing: -0.5,
    marginBottom: space.md,
  },
  body: {
    color: colors.textMuted,
    fontSize: 15,
    lineHeight: 22,
    marginBottom: space.xl,
  },
  card: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    padding: space.lg,
    marginBottom: space.xl,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 6,
  },
  k: { color: colors.textMuted, fontSize: 14 },
  v: { color: colors.text, fontSize: 14, fontWeight: '600' },
  note: { color: colors.textMuted, fontSize: 13, lineHeight: 20 },
});
