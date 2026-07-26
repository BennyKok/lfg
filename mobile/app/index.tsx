import { StatusBar } from 'expo-status-bar';
import { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TodoRow } from '../src/TodoRow';
import { colors, radius, space } from '../src/theme';
import { useTodos, type Filter } from '../src/useTodos';

const FILTERS: Filter[] = ['all', 'active', 'done'];

export default function TodosScreen() {
  const insets = useSafeAreaInsets();
  const { todos, loaded, addTodo, toggleTodo, removeTodo, clearDone } =
    useTodos();
  const [draft, setDraft] = useState('');
  const [filter, setFilter] = useState<Filter>('all');

  const visible = useMemo(() => {
    if (filter === 'active') return todos.filter((t) => !t.done);
    if (filter === 'done') return todos.filter((t) => t.done);
    return todos;
  }, [todos, filter]);

  const remaining = todos.filter((t) => !t.done).length;
  const doneCount = todos.length - remaining;

  const submit = () => {
    addTodo(draft);
    setDraft('');
  };

  return (
    <View style={[styles.screen, { paddingTop: insets.top + space.lg }]}>
      <StatusBar style="light" />

      <View style={styles.header}>
        <Text style={styles.heading}>Todos</Text>
        <Text style={styles.sub}>
          {loaded
            ? remaining === 0 && todos.length > 0
              ? 'All done — nice.'
              : `${remaining} left${doneCount ? ` · ${doneCount} done` : ''}`
            : 'Loading…'}
        </Text>
      </View>

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={insets.top + space.lg}
        style={styles.flex}
      >
        <View style={styles.composer}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            onSubmitEditing={submit}
            placeholder="What needs doing?"
            placeholderTextColor={colors.textMuted}
            style={styles.input}
            returnKeyType="done"
            submitBehavior="submit"
            accessibilityLabel="New todo"
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Add todo"
            disabled={!draft.trim()}
            onPress={submit}
            style={({ pressed }) => [
              styles.addButton,
              !draft.trim() && styles.addButtonDisabled,
              pressed && draft.trim() ? { opacity: 0.8 } : null,
            ]}
          >
            <Text style={styles.addButtonText}>Add</Text>
          </Pressable>
        </View>

        <View style={styles.filters}>
          {FILTERS.map((f) => {
            const active = f === filter;
            return (
              <Pressable
                key={f}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                onPress={() => setFilter(f)}
                style={[styles.chip, active && styles.chipActive]}
              >
                <Text style={[styles.chipText, active && styles.chipTextActive]}>
                  {f}
                </Text>
              </Pressable>
            );
          })}
          <View style={styles.flex} />
          {doneCount > 0 ? (
            <Pressable
              accessibilityRole="button"
              onPress={clearDone}
              hitSlop={8}
            >
              <Text style={styles.clear}>Clear done</Text>
            </Pressable>
          ) : null}
        </View>

        {!loaded ? (
          <ActivityIndicator color={colors.accent} style={styles.loader} />
        ) : (
          <FlatList
            data={visible}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => (
              <TodoRow todo={item} onToggle={toggleTodo} onRemove={removeTodo} />
            )}
            keyboardDismissMode="on-drag"
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.list}
            ListEmptyComponent={
              <Text style={styles.empty}>
                {filter === 'all'
                  ? 'Nothing here yet. Add your first todo above.'
                  : `No ${filter} todos.`}
              </Text>
            }
          />
        )}
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
    paddingHorizontal: space.lg,
  },
  header: { marginBottom: space.lg },
  heading: {
    color: colors.text,
    fontSize: 34,
    fontWeight: '800',
    letterSpacing: -0.5,
  },
  sub: { color: colors.textMuted, fontSize: 15, marginTop: space.xs },
  composer: { flexDirection: 'row', gap: space.sm, marginBottom: space.md },
  input: {
    flex: 1,
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    paddingHorizontal: space.lg,
    paddingVertical: Platform.OS === 'ios' ? 14 : 10,
    color: colors.text,
    fontSize: 16,
  },
  addButton: {
    justifyContent: 'center',
    paddingHorizontal: space.xl,
    borderRadius: radius.md,
    backgroundColor: colors.accent,
  },
  addButtonDisabled: { opacity: 0.35 },
  addButtonText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  filters: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginBottom: space.md,
  },
  chip: {
    paddingHorizontal: space.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
  },
  chipActive: { backgroundColor: colors.accentSoft, borderColor: colors.accent },
  chipText: {
    color: colors.textMuted,
    fontSize: 13,
    textTransform: 'capitalize',
  },
  chipTextActive: { color: colors.accent, fontWeight: '600' },
  clear: { color: colors.danger, fontSize: 13 },
  list: { paddingTop: space.xs, paddingBottom: space.xl },
  loader: { marginTop: space.xl },
  empty: {
    color: colors.textMuted,
    textAlign: 'center',
    marginTop: space.xl * 2,
    fontSize: 15,
  },
});
