import * as Haptics from "expo-haptics";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { Session } from "./lfg";
import { colors, radius, space } from "./theme";

export function Header({
  title,
  subtitle,
}: {
  title: string;
  subtitle?: string;
}) {
  return (
    <View style={s.header}>
      <View style={s.brandIsland}>
        <Text style={s.brand}>lfg</Text>
      </View>
      <View style={s.headerCopy}>
        <Text style={s.heading}>{title}</Text>
        {subtitle ? <Text style={s.sub}>{subtitle}</Text> : null}
      </View>
    </View>
  );
}
export function SessionCard({
  session,
  onPress,
}: {
  session: Session;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={() => {
        void Haptics.selectionAsync();
        onPress();
      }}
      style={({ pressed }) => [s.card, pressed && s.pressed]}
    >
      <View style={s.meta}>
        <View
          style={[
            s.dot,
            session.busy && s.busy,
            session.status === "blocked" && s.blocked,
          ]}
        />
        <Text style={s.title} numberOfLines={1}>
          {session.title || session.lastUserText || "Untitled session"}
        </Text>
        <Text style={s.chevron}>›</Text>
      </View>
      {session.last?.text ? (
        <Text style={s.preview} numberOfLines={2}>
          {session.last.text}
        </Text>
      ) : null}
      <View style={s.footer}>
        <Text style={s.agent}>{session.agent || "agent"}</Text>
        <Text style={s.project}>{session.project || "lfg"}</Text>
        <Text style={s.model}>
          {session.model || "default"}
          {session.assignedUser
            ? ` · ${session.assignedUser.split("@")[0]}`
            : ""}
        </Text>
      </View>
    </Pressable>
  );
}
export const shared = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { paddingHorizontal: space.md, paddingBottom: 140, gap: space.md },
  label: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 1.2,
  },
  input: {
    color: colors.text,
    backgroundColor: colors.card,
    borderColor: colors.borderSoft,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.lg,
    padding: space.md,
  },
  button: {
    minHeight: 46,
    borderRadius: radius.md,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: space.lg,
  },
  buttonText: { color: "white", fontWeight: "800" },
  error: { color: colors.danger, fontSize: 12 },
  chip: {
    borderRadius: radius.pill,
    backgroundColor: colors.secondary,
    borderColor: colors.borderSoft,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: space.md,
    paddingVertical: 8,
  },
  chipOn: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  chipText: { color: colors.textMuted, fontWeight: "700" },
  chipTextOn: { color: colors.accent },
});
const s = StyleSheet.create({
  header: {
    paddingHorizontal: space.md,
    paddingTop: space.sm,
    paddingBottom: space.md,
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
  },
  brandIsland: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.card,
    borderColor: colors.borderSoft,
    borderWidth: StyleSheet.hairlineWidth,
  },
  brand: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "900",
    letterSpacing: -1,
  },
  headerCopy: { flex: 1 },
  heading: {
    color: colors.text,
    fontSize: 28,
    lineHeight: 32,
    fontWeight: "800",
    letterSpacing: -0.7,
  },
  sub: { color: colors.textMuted, fontSize: 12, marginTop: 1 },
  card: {
    backgroundColor: colors.card,
    borderColor: colors.borderSoft,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.lg,
    paddingHorizontal: space.md,
    paddingVertical: 10,
    marginHorizontal: space.md,
    marginBottom: space.sm,
  },
  pressed: {
    backgroundColor: colors.cardPressed,
    transform: [{ scale: 0.99 }],
  },
  meta: { flexDirection: "row", gap: 8, alignItems: "center" },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.textMuted,
  },
  busy: { backgroundColor: colors.done },
  blocked: { backgroundColor: colors.warning },
  title: { color: colors.text, fontSize: 14, fontWeight: "700", flex: 1 },
  chevron: { color: colors.textMuted, fontSize: 22, lineHeight: 22 },
  preview: {
    color: colors.textMuted,
    fontSize: 13,
    lineHeight: 18,
    marginLeft: 16,
    marginTop: 4,
  },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginLeft: 16,
    marginTop: 8,
  },
  agent: { color: colors.textMuted, fontSize: 10, fontWeight: "700" },
  project: { color: colors.accent, fontSize: 10, fontWeight: "700" },
  model: { color: colors.textMuted, fontSize: 10, marginLeft: "auto" },
});
