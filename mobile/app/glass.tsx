import {
  GlassContainer,
  GlassView,
  isGlassEffectAPIAvailable,
  isLiquidGlassAvailable,
} from 'expo-glass-effect';
import { LinearGradient } from 'expo-linear-gradient';
import { StatusBar } from 'expo-status-bar';
import { useState } from 'react';
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { space } from '../src/theme';

// Liquid Glass only *reads* as glass when there is something busy behind it,
// so this screen deliberately puts saturated, overlapping colour underneath
// every sample.
const liquid = isLiquidGlassAvailable();
const apiAvailable = isGlassEffectAPIAvailable();

// On iOS < 26 (and web) GlassView renders as a plain transparent View, which
// would make every sample below invisible. Give it a visible frosted stand-in
// so the layout still reads.
const fallback = liquid
  ? null
  : {
      backgroundColor: 'rgba(255,255,255,0.14)',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: 'rgba(255,255,255,0.32)',
    };

function Backdrop() {
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <LinearGradient
        colors={['#1B1035', '#3D1D6B', '#0E2A5E', '#08111F']}
        locations={[0, 0.35, 0.7, 1]}
        style={StyleSheet.absoluteFill}
      />
      <View style={[styles.blob, styles.blobA]} />
      <View style={[styles.blob, styles.blobB]} />
      <View style={[styles.blob, styles.blobC]} />
    </View>
  );
}

function Section({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {note ? <Text style={styles.sectionNote}>{note}</Text> : null}
      {children}
    </View>
  );
}

export default function GlassScreen() {
  const insets = useSafeAreaInsets();
  const [spacing, setSpacing] = useState(20);
  const [taps, setTaps] = useState(0);

  return (
    <View style={styles.screen}>
      <StatusBar style="light" />
      <Backdrop />

      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingTop: insets.top + space.lg },
        ]}
        contentInsetAdjustmentBehavior="automatic"
      >
        <Text style={styles.heading}>Liquid Glass</Text>

        {/* Availability readout — tells you instantly which path you're on. */}
        <View
          style={[
            styles.statusCard,
            { borderColor: liquid ? '#3DDC97' : '#FFB020' },
          ]}
        >
          <Text style={styles.statusLine}>
            <Text style={styles.statusKey}>isLiquidGlassAvailable() </Text>
            <Text style={{ color: liquid ? '#3DDC97' : '#FFB020' }}>
              {String(liquid)}
            </Text>
          </Text>
          <Text style={styles.statusLine}>
            <Text style={styles.statusKey}>isGlassEffectAPIAvailable() </Text>
            <Text style={{ color: apiAvailable ? '#3DDC97' : '#FFB020' }}>
              {String(apiAvailable)}
            </Text>
          </Text>
          <Text style={styles.statusLine}>
            <Text style={styles.statusKey}>platform </Text>
            <Text style={styles.statusVal}>
              {Platform.OS} {String(Platform.Version)}
            </Text>
          </Text>
          <Text style={styles.statusHint}>
            {liquid
              ? 'Real UIVisualEffectView glass below.'
              : 'iOS 26+ required — GlassView falls back to a plain View, so the cards below will look flat. The tab bar is still a real UITabBar.'}
          </Text>
        </View>

        <Section
          title="glassEffectStyle"
          note="regular refracts and blurs; clear is thinner and lets more through."
        >
          <View style={styles.row}>
            <GlassView style={[styles.tile, fallback]} glassEffectStyle="regular">
              <Text style={styles.tileLabel}>regular</Text>
            </GlassView>
            <GlassView style={[styles.tile, fallback]} glassEffectStyle="clear">
              <Text style={styles.tileLabel}>clear</Text>
            </GlassView>
          </View>
        </Section>

        <Section title="tintColor" note="Glass takes a colour cast, not a fill.">
          <View style={styles.row}>
            <GlassView style={[styles.tile, fallback]} tintColor="#5B8CFF">
              <Text style={styles.tileLabel}>blue</Text>
            </GlassView>
            <GlassView style={[styles.tile, fallback]} tintColor="#FF6B6B">
              <Text style={styles.tileLabel}>red</Text>
            </GlassView>
            <GlassView style={[styles.tile, fallback]} tintColor="#3DDC97">
              <Text style={styles.tileLabel}>green</Text>
            </GlassView>
          </View>
        </Section>

        <Section
          title="isInteractive"
          note="Interactive glass responds to touch with a specular highlight."
        >
          <Pressable onPress={() => setTaps((n) => n + 1)}>
            <GlassView style={[styles.wideTile, fallback]} isInteractive>
              <Text style={styles.tileLabel}>
                {taps === 0 ? 'Press and hold me' : `pressed ${taps}×`}
              </Text>
            </GlassView>
          </Pressable>
        </Section>

        <Section
          title="GlassContainer"
          note={`Glass shapes within \`spacing\` of each other merge like liquid. spacing = ${spacing}`}
        >
          <GlassContainer spacing={spacing} style={styles.container}>
            <GlassView style={[styles.circle, fallback]} glassEffectStyle="regular" />
            <GlassView style={[styles.circle, fallback]} glassEffectStyle="regular" />
          </GlassContainer>
          <View style={styles.row}>
            {[0, 20, 40, 60].map((s) => (
              <Pressable
                key={s}
                onPress={() => setSpacing(s)}
                style={[styles.pill, spacing === s && styles.pillActive]}
              >
                <Text
                  style={[
                    styles.pillText,
                    spacing === s && styles.pillTextActive,
                  ]}
                >
                  {s}
                </Text>
              </Pressable>
            ))}
          </View>
        </Section>

        <Section
          title="colorScheme"
          note="Force the glass appearance regardless of system theme."
        >
          <View style={styles.row}>
            <GlassView style={[styles.tile, fallback]} colorScheme="light">
              <Text style={[styles.tileLabel, { color: '#111' }]}>light</Text>
            </GlassView>
            <GlassView style={[styles.tile, fallback]} colorScheme="dark">
              <Text style={styles.tileLabel}>dark</Text>
            </GlassView>
          </View>
        </Section>

        <Text style={styles.footer}>
          Scroll this list under the tab bar — on iOS 26 the bar itself is
          Liquid Glass and reacts to the content passing beneath it.
        </Text>
      </ScrollView>

      {/* Floating glass pill: the classic iOS 26 overlay-on-scrolling-content. */}
      <View
        style={[styles.floatWrap, { bottom: insets.bottom + 12 }]}
        pointerEvents="box-none"
      >
        <GlassView style={[styles.float, fallback]} isInteractive glassEffectStyle="regular">
          <Text style={styles.floatText}>floating glass pill</Text>
        </GlassView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#08111F' },
  content: { paddingHorizontal: space.lg, paddingBottom: 140 },
  heading: {
    color: '#fff',
    fontSize: 34,
    fontWeight: '800',
    letterSpacing: -0.5,
    marginBottom: space.md,
  },

  blob: { position: 'absolute', borderRadius: 999, opacity: 0.55 },
  blobA: {
    width: 320,
    height: 320,
    backgroundColor: '#FF3D81',
    top: 80,
    left: -90,
  },
  blobB: {
    width: 280,
    height: 280,
    backgroundColor: '#00E0C6',
    top: 420,
    right: -80,
  },
  blobC: {
    width: 360,
    height: 360,
    backgroundColor: '#7A5BFF',
    top: 820,
    left: -40,
  },

  statusCard: {
    borderWidth: 1,
    borderRadius: 14,
    padding: space.lg,
    marginBottom: space.xl,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  statusLine: { fontSize: 13, marginBottom: 4 },
  statusKey: { color: '#9AA4B8', fontFamily: Platform.select({ ios: 'Menlo' }) },
  statusVal: { color: '#fff' },
  statusHint: { color: '#C8D0E0', fontSize: 12, marginTop: space.sm },

  section: { marginBottom: space.xl },
  sectionTitle: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '700',
    marginBottom: 2,
  },
  sectionNote: { color: '#B6C0D4', fontSize: 13, marginBottom: space.md },

  row: { flexDirection: 'row', gap: space.md, flexWrap: 'wrap' },
  tile: {
    width: 96,
    height: 96,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  wideTile: {
    height: 84,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  tileLabel: { color: '#fff', fontWeight: '600', fontSize: 14 },

  container: {
    height: 140,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginBottom: space.md,
  },
  circle: { width: 92, height: 92, borderRadius: 46 },

  pill: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  pillActive: { backgroundColor: '#fff' },
  pillText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  pillTextActive: { color: '#111' },

  footer: {
    color: '#B6C0D4',
    fontSize: 13,
    lineHeight: 19,
    marginTop: space.sm,
  },

  floatWrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  float: {
    paddingHorizontal: 22,
    paddingVertical: 14,
    borderRadius: 999,
    overflow: 'hidden',
  },
  floatText: { color: '#fff', fontWeight: '600', fontSize: 14 },
});
