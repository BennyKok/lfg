import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
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
import { colors, space } from "../../src/theme";
export default function NewSession() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { boot, api, refresh, userEmail, setUserEmail } = useLfg();
  const repos = boot?.repos || [];
  const agents = (boot?.codingAgents || []).filter(
    (a) => a.visible !== false && a.status?.configured,
  );
  const [prompt, setPrompt] = useState("");
  const [repo, setRepo] = useState("");
  const [agent, setAgent] = useState("aisdk");
  const [worktree, setWorktree] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!repo && repos[0]) setRepo(repos[0].cwd);
    if (!agents.some((a) => a.key === agent) && agents[0])
      setAgent(agents[0].key);
  }, [agents, agent, repo, repos]);
  const model = useMemo(
    () => boot?.models?.find((m) => m.key === agent)?.defaultModel,
    [agent, boot?.models],
  );
  async function create() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ sessionId?: string }>("/api/sessions/new", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd: repo,
          prompt: prompt.trim(),
          agent,
          model,
          worktree,
          user: userEmail,
        }),
      });
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setPrompt("");
      await refresh();
      if (r.sessionId) router.push(`/session/${r.sessionId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <KeyboardAvoidingView
      style={[shared.screen, { paddingTop: insets.top }]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <Header
        title="Start an agent"
        subtitle="Same LFG backend, native launch flow"
      />
      <ScrollView
        contentContainerStyle={shared.content}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={shared.label}>WHAT SHOULD IT DO?</Text>
        <TextInput
          value={prompt}
          onChangeText={setPrompt}
          multiline
          placeholder="Build, fix, research, or review…"
          placeholderTextColor={colors.textMuted}
          style={[shared.input, s.prompt]}
        />
        <Text style={shared.label}>REPOSITORY</Text>
        <View style={s.chips}>
          {repos.map((x) => (
            <Pressable
              key={x.cwd}
              onPress={() => setRepo(x.cwd)}
              style={[shared.chip, repo === x.cwd && shared.chipOn]}
            >
              <Text
                style={[shared.chipText, repo === x.cwd && shared.chipTextOn]}
              >
                {x.name}
              </Text>
            </Pressable>
          ))}
        </View>
        <Text style={shared.label}>RUN AS</Text>
        <View style={s.chips}>
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
        <Text style={shared.label}>AGENT</Text>
        <View style={s.chips}>
          {agents.map((x) => (
            <Pressable
              key={x.key}
              onPress={() => setAgent(x.key)}
              style={[shared.chip, agent === x.key && shared.chipOn]}
            >
              <Text
                style={[shared.chipText, agent === x.key && shared.chipTextOn]}
              >
                {x.label}
              </Text>
            </Pressable>
          ))}
        </View>
        <Pressable onPress={() => setWorktree((v) => !v)} style={s.toggle}>
          <Text style={s.check}>{worktree ? "✓" : "○"}</Text>
          <Text style={s.toggleText}>New worktree · isolate changes</Text>
        </Pressable>
        <Text style={s.model}>Model: {model || "default"}</Text>
        {error ? <Text style={shared.error}>{error}</Text> : null}
        <Pressable
          disabled={busy || !prompt.trim() || !repo || !userEmail}
          onPress={create}
          style={[
            shared.button,
            (busy || !prompt.trim() || !repo || !userEmail) && s.disabled,
          ]}
        >
          <Text style={shared.buttonText}>
            {busy ? "Launching…" : "Launch agent"}
          </Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
const s = StyleSheet.create({
  prompt: { minHeight: 150, fontSize: 18, textAlignVertical: "top" },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  toggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingVertical: space.md,
  },
  check: { color: colors.accent, fontSize: 22, fontWeight: "900" },
  toggleText: { color: colors.text },
  model: { color: colors.textMuted, fontSize: 12 },
  disabled: { opacity: 0.45 },
});
