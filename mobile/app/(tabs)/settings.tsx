import Constants from "expo-constants";
import { isLiquidGlassAvailable } from "expo-glass-effect";
import { useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Header, shared } from "../../src/components";
import { useLfg } from "../../src/lfg";
import { colors, radius, space } from "../../src/theme";
export default function Settings() {
  const insets = useSafeAreaInsets();
  const {
    baseUrl,
    setBaseUrl,
    refresh,
    boot,
    error,
    loading,
    userEmail,
    setUserEmail,
  } = useLfg();
  const [draft, setDraft] = useState(baseUrl);
  async function connect() {
    await setBaseUrl(draft);
    await refresh();
  }
  return (
    <KeyboardAvoidingView
      style={[shared.screen, { paddingTop: insets.top }]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <Header title="Settings" subtitle="Connect this phone to your LFG host" />
      <ScrollView contentContainerStyle={shared.content}>
        <View style={s.card}>
          <Text style={shared.label}>LFG SERVER URL</Text>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            autoCapitalize="none"
            keyboardType="url"
            style={[shared.input, s.input]}
          />
          <Pressable onPress={connect} style={shared.button}>
            <Text style={shared.buttonText}>
              {loading ? "Connecting…" : "Connect"}
            </Text>
          </Pressable>
          <Text
            style={[s.status, { color: boot ? colors.done : colors.danger }]}
          >
            {boot
              ? `● Connected · LFG ${boot.version}`
              : `● ${error || "Not connected"}`}
          </Text>
        </View>
        <View style={s.card}>
          <Text style={shared.label}>WHO ARE YOU?</Text>
          <View style={s.users}>
            {(boot?.users || []).map((user) => (
              <Pressable
                key={user.email}
                onPress={() => setUserEmail(user.email)}
                style={[shared.chip, userEmail === user.email && shared.chipOn]}
              >
                <Text
                  style={[
                    shared.chipText,
                    userEmail === user.email && shared.chipTextOn,
                  ]}
                >
                  {user.name || user.email}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
        <View style={s.card}>
          <Text style={shared.label}>NATIVE RUNTIME</Text>
          <Text style={s.row}>
            Expo SDK {Constants.expoConfig?.sdkVersion || "57"}
          </Text>
          <Text style={s.row}>iOS {String(Platform.Version)}</Text>
          <Text style={s.row}>
            Liquid Glass {isLiquidGlassAvailable() ? "available" : "fallback"}
          </Text>
          <Text style={s.row}>Native UIKit tab bar</Text>
        </View>
        <Text style={s.note}>
          Use your host’s Tailscale IP away from local Wi‑Fi. The local LFG API
          has no application-layer login, so never expose port 8766 directly to
          the public internet.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
const s = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.lg,
    padding: space.lg,
    gap: space.md,
  },
  input: { marginVertical: space.sm },
  status: { fontSize: 12 },
  users: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  row: {
    color: colors.text,
    paddingVertical: space.sm,
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  note: { color: colors.textMuted, fontSize: 12, lineHeight: 18 },
});
