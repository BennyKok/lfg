import * as Haptics from "expo-haptics";
import { useLocalSearchParams, useNavigation } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AppState,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { shared } from "../../src/components";
import { useLfg, type Message } from "../../src/lfg";
import { colors, radius, space } from "../../src/theme";

const key = (m: Message, i: number) =>
  m.id || `${m.role}-${m.kind}-${m.ts || i}`;
const merge = (old: Message[], next: Message[]) => {
  const map = new Map(old.map((m, i) => [key(m, i), m]));
  next.forEach((m, i) => map.set(key(m, i), m));
  return [...map.values()].sort((a, b) => (a.ts || 0) - (b.ts || 0));
};

export default function SessionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const nav = useNavigation();
  const insets = useSafeAreaInsets();
  const { boot, api, absolute, baseUrl, refresh } = useLfg();
  const session = useMemo(
    () =>
      boot?.sessions?.find(
        (x) => x.sessionId === id || x.nativeSessionId === id,
      ),
    [boot?.sessions, id],
  );
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(!!session?.busy);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<{
    question?: string;
    options: { index: number; label: string }[];
  } | null>(null);
  const list = useRef<FlatList<Message>>(null);
  useEffect(() => {
    nav.setOptions({ title: session?.title || "Session" });
  }, [nav, session?.title]);
  const load = useCallback(async () => {
    try {
      const data = await api<{ messages?: Message[] }>(
        `/api/sessions/${id}/messages?limit=100`,
      );
      setMessages(data.messages || []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [api, id]);
  useEffect(() => {
    void load();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        void load();
        void refresh();
      }
    });
    return () => subscription.remove();
  }, [load, refresh]);
  useEffect(() => {
    let closed = false;
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const connect = () => {
      ws = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/api/live/ws`);
      ws.onopen = () => {
        setError(null);
        ws?.send(
          JSON.stringify({
            t: "subscribe",
            channels: [
              { kind: "transcript", key: id },
              { kind: "status", key: "*" },
            ],
          }),
        );
      };
      ws.onmessage = (event) => {
        try {
          const f = JSON.parse(String(event.data));
          if (f.t === "ping") {
            ws?.send(JSON.stringify({ t: "pong", id: f.id }));
            return;
          }
          const p = f.t === "delta" ? f.delta : f;
          if (
            (p.t === "batch" || p.t === "page" || p.t === "snapshot") &&
            p.sid === id
          )
            setMessages((v) => merge(v, p.messages || []));
          if (p.t === "msg" && p.sid === id) {
            const m = p.message || p.m;
            if (m) setMessages((v) => merge(v, [m]));
          }
          if (p.t === "busy" && p.sid === id) setBusy(!!p.busy);
          if (p.t === "prompt" && p.sid === id) setPrompt(p.prompt || null);
          if (p.t === "status") {
            const row = p.rows?.find((x: any) => x.sessionId === id);
            if (row) setBusy(!!row.busy);
          }
        } catch {}
      };
      ws.onclose = () => {
        if (!closed) {
          setError("Live connection lost — reconnecting…");
          retry = setTimeout(connect, 1500);
        }
      };
    };
    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      ws?.close();
    };
  }, [baseUrl, id]);
  async function send() {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    setSending(true);
    const optimistic = {
      id: `pending-${Date.now()}`,
      role: "user",
      kind: "text",
      text,
      ts: Date.now(),
      pending: true,
    };
    setMessages((v) => [...v, optimistic]);
    try {
      await api(`/api/sessions/${id}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, mode: busy ? "queue" : "steer" }),
      });
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      setTimeout(() => void load(), 500);
    } catch (e) {
      setMessages((v) => v.filter((m) => m.id !== optimistic.id));
      setDraft(text);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }
  async function stop() {
    await api(`/api/sessions/${id}/interrupt`, { method: "POST" });
    setBusy(false);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    await refresh();
  }
  async function resolvePrompt(index?: number) {
    await api(
      `/api/sessions/${id}/${index === undefined ? "dismiss" : "answer"}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: index === undefined ? undefined : JSON.stringify({ index }),
      },
    );
    setPrompt(null);
  }
  async function closeSession() {
    await api(`/api/sessions/${id}/close`, { method: "POST" });
    await refresh();
    nav.goBack();
  }
  return (
    <KeyboardAvoidingView
      style={shared.screen}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={88}
    >
      <View style={s.bar}>
        <View style={[s.dot, busy && s.busy]} />
        <Text style={s.meta}>
          {session?.agent || "agent"} · {session?.model || "default"} ·{" "}
          {session?.project || "lfg"}
        </Text>
        {busy ? (
          <Pressable onPress={stop}>
            <Text style={s.stop}>Stop</Text>
          </Pressable>
        ) : (
          <Pressable onPress={closeSession}>
            <Text style={s.stop}>Close</Text>
          </Pressable>
        )}
      </View>
      <FlatList
        ref={list}
        data={messages}
        keyExtractor={key}
        renderItem={({ item }) => <Bubble message={item} absolute={absolute} />}
        contentContainerStyle={s.messages}
        onContentSizeChange={() =>
          list.current?.scrollToEnd({ animated: false })
        }
        ListEmptyComponent={
          <Text style={s.empty}>No transcript messages yet.</Text>
        }
      />
      {prompt ? (
        <View style={s.prompt}>
          <Text style={s.promptTitle}>
            {prompt.question || "Agent needs your input"}
          </Text>
          <View style={s.promptOptions}>
            {prompt.options.map((option) => (
              <Pressable
                key={option.index}
                onPress={() => resolvePrompt(option.index)}
                style={shared.chip}
              >
                <Text style={shared.chipText}>{option.label}</Text>
              </Pressable>
            ))}
            <Pressable onPress={() => resolvePrompt()} style={shared.chip}>
              <Text style={s.stop}>Dismiss</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
      {error ? <Text style={s.error}>{error}</Text> : null}
      <View
        style={[
          s.composer,
          { paddingBottom: Math.max(insets.bottom, space.sm) },
        ]}
      >
        <TextInput
          value={draft}
          onChangeText={setDraft}
          multiline
          placeholder={busy ? "Queue a follow-up…" : "Message the agent…"}
          placeholderTextColor={colors.textMuted}
          style={s.input}
        />
        <Pressable
          disabled={!draft.trim() || sending}
          onPress={send}
          style={[
            shared.button,
            s.send,
            (!draft.trim() || sending) && s.disabled,
          ]}
        >
          <Text style={s.sendGlyph}>{busy ? "＋" : "↑"}</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}
function Bubble({
  message,
  absolute,
}: {
  message: Message;
  absolute: (p: string) => string;
}) {
  const user = message.role === "user";
  const uri = message.url
    ? message.url.startsWith("http")
      ? message.url
      : absolute(message.url)
    : message.artifactId
      ? absolute(`/api/artifacts/${message.artifactId}`)
      : null;
  if (message.kind === "image" && uri)
    return (
      <View style={[s.bubble, s.agentBubble]}>
        <Image source={{ uri }} style={s.image} />
        {message.caption ? (
          <Text style={s.caption}>{message.caption}</Text>
        ) : null}
      </View>
    );
  return (
    <View style={[s.bubble, user ? s.userBubble : s.agentBubble]}>
      <Text style={s.role}>
        {user ? "YOU" : message.role === "assistant" ? "AGENT" : "SYSTEM"}
      </Text>
      <Text selectable style={s.text}>
        {message.text || `[${message.kind || "event"}]`}
      </Text>
      {message.pending ? <Text style={s.pending}>Sending…</Text> : null}
    </View>
  );
}
const s = StyleSheet.create({
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: 10,
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  dot: {
    width: 9,
    height: 9,
    borderRadius: 5,
    backgroundColor: colors.textMuted,
  },
  busy: { backgroundColor: colors.done },
  meta: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "600",
    flex: 1,
  },
  stop: { color: colors.danger, fontWeight: "800" },
  prompt: {
    backgroundColor: colors.card,
    padding: space.md,
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  promptTitle: {
    color: colors.text,
    fontWeight: "800",
    marginBottom: space.sm,
  },
  promptOptions: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  messages: {
    paddingHorizontal: space.md,
    paddingVertical: space.lg,
    gap: space.md,
  },
  bubble: {
    maxWidth: "92%",
    borderRadius: radius.xl,
    paddingHorizontal: space.md,
    paddingVertical: 10,
  },
  userBubble: { backgroundColor: colors.secondary, alignSelf: "flex-end" },
  agentBubble: {
    backgroundColor: "transparent",
    alignSelf: "flex-start",
    paddingLeft: 0,
  },
  role: {
    color: colors.textMuted,
    fontSize: 9,
    fontWeight: "900",
    letterSpacing: 1.2,
  },
  text: { color: colors.text, fontSize: 15, lineHeight: 21, marginTop: 4 },
  pending: { color: colors.textMuted, fontSize: 10 },
  image: { width: 280, height: 220, borderRadius: radius.md },
  caption: { color: colors.textMuted, marginTop: space.sm },
  empty: { color: colors.textMuted, textAlign: "center", marginTop: 80 },
  error: { color: colors.danger, fontSize: 12, paddingHorizontal: space.lg },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: space.sm,
    padding: space.sm,
    borderTopColor: colors.borderSoft,
    borderTopWidth: StyleSheet.hairlineWidth,
    backgroundColor: colors.bg,
  },
  input: {
    flex: 1,
    minHeight: 46,
    maxHeight: 120,
    color: colors.text,
    backgroundColor: colors.secondary,
    borderRadius: 22,
    paddingHorizontal: 15,
    paddingVertical: 12,
  },
  send: {
    minWidth: 44,
    width: 44,
    height: 44,
    minHeight: 44,
    borderRadius: 22,
    paddingHorizontal: 0,
  },
  sendGlyph: { color: "#fff", fontSize: 22, lineHeight: 24, fontWeight: "800" },
  disabled: { opacity: 0.45 },
});
