import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  RefreshControl,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Header, SessionCard, shared } from "../../src/components";
import { useLfg, type Session } from "../../src/lfg";
import { colors, radius, space } from "../../src/theme";

export default function Live() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { boot, loading, error, refresh } = useLfg();
  const [query, setQuery] = useState("");
  useFocusEffect(
    useCallback(() => {
      void refresh();
      const timer = setInterval(() => void refresh(), 5000);
      return () => clearInterval(timer);
    }, [refresh]),
  );
  const sessions = useMemo(
    () =>
      (boot?.sessions || [])
        .filter(
          (session) =>
            session.sessionId &&
            [
              session.title,
              session.lastUserText,
              session.project,
              session.agent,
            ].some((value) =>
              String(value || "")
                .toLowerCase()
                .includes(query.toLowerCase()),
            ),
        )
        .sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0)),
    [boot?.sessions, query],
  );
  const working = sessions.filter(
    (session) => session.busy || session.status === "blocked",
  );
  const idle = sessions.filter(
    (session) => !session.busy && session.status !== "blocked",
  );
  const sections = [
    ...(working.length
      ? [{ title: "Working", tint: colors.done, data: working }]
      : []),
    ...(idle.length
      ? [{ title: "Idle", tint: colors.textMuted, data: idle }]
      : []),
  ];
  return (
    <View style={[shared.screen, { paddingTop: insets.top }]}>
      <Header
        title="Live"
        subtitle={`${working.length} working · ${sessions.length} sessions · v${boot?.version || "—"}`}
      />
      <View style={s.searchShell}>
        <Text style={s.searchIcon}>⌕</Text>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search"
          placeholderTextColor={colors.textMuted}
          style={s.search}
        />
      </View>
      {error ? <Text style={s.error}>Can’t reach LFG · {error}</Text> : null}
      <SectionList
        sections={sections}
        keyExtractor={(item) => item.sessionId!}
        renderItem={({ item }: { item: Session }) => (
          <SessionCard
            session={item}
            onPress={() => router.push(`/session/${item.sessionId}`)}
          />
        )}
        renderSectionHeader={({ section }) => (
          <View style={s.sectionHeader}>
            <View style={[s.sectionDot, { backgroundColor: section.tint }]} />
            <Text style={s.sectionTitle}>{section.title}</Text>
            <View style={s.count}>
              <Text style={s.countText}>{section.data.length}</Text>
            </View>
          </View>
        )}
        stickySectionHeadersEnabled={false}
        refreshControl={
          <RefreshControl
            refreshing={loading}
            onRefresh={refresh}
            tintColor={colors.accent}
          />
        }
        contentContainerStyle={s.list}
        ListEmptyComponent={
          loading ? (
            <ActivityIndicator color={colors.accent} />
          ) : (
            <Text style={s.empty}>No running sessions</Text>
          )
        }
      />
    </View>
  );
}

const s = StyleSheet.create({
  searchShell: {
    marginHorizontal: space.md,
    marginBottom: space.md,
    height: 38,
    borderRadius: radius.md,
    backgroundColor: colors.secondary,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 11,
  },
  searchIcon: {
    color: colors.textMuted,
    fontSize: 20,
    marginRight: 7,
    marginTop: -2,
  },
  search: { flex: 1, color: colors.text, fontSize: 15, paddingVertical: 0 },
  error: {
    color: colors.danger,
    marginHorizontal: space.md,
    marginBottom: space.md,
    fontSize: 13,
  },
  list: { paddingBottom: 130 },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingHorizontal: 14,
    paddingTop: 8,
    paddingBottom: 8,
  },
  sectionDot: { width: 6, height: 6, borderRadius: 3 },
  sectionTitle: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.7,
    textTransform: "uppercase",
  },
  count: {
    backgroundColor: colors.secondary,
    borderRadius: radius.pill,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  countText: { color: colors.textMuted, fontSize: 10, fontWeight: "600" },
  empty: {
    color: colors.textMuted,
    textAlign: "center",
    marginTop: 120,
    fontSize: 14,
    fontWeight: "600",
  },
});
