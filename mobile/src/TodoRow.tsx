import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, radius, space } from './theme';
import type { Todo } from './useTodos';

type Props = {
  todo: Todo;
  onToggle: (id: string) => void;
  onRemove: (id: string) => void;
};

function TodoRowBase({ todo, onToggle, onRemove }: Props) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: todo.done }}
      accessibilityLabel={todo.title}
      onPress={() => onToggle(todo.id)}
      style={({ pressed }) => [
        styles.row,
        pressed && { backgroundColor: colors.cardPressed },
      ]}
    >
      <View style={[styles.checkbox, todo.done && styles.checkboxDone]}>
        {todo.done ? <Text style={styles.checkmark}>✓</Text> : null}
      </View>

      <Text
        style={[styles.title, todo.done && styles.titleDone]}
        numberOfLines={2}
      >
        {todo.title}
      </Text>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Delete ${todo.title}`}
        hitSlop={12}
        onPress={() => onRemove(todo.id)}
        style={styles.delete}
      >
        <Text style={styles.deleteText}>×</Text>
      </Pressable>
    </Pressable>
  );
}

export const TodoRow = memo(TodoRowBase);

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    marginBottom: space.sm,
  },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: radius.sm,
    borderWidth: 2,
    borderColor: colors.textMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxDone: {
    borderColor: colors.done,
    backgroundColor: colors.done,
  },
  checkmark: {
    color: colors.bg,
    fontSize: 15,
    fontWeight: '800',
    lineHeight: 18,
  },
  title: {
    flex: 1,
    color: colors.text,
    fontSize: 16,
  },
  titleDone: {
    color: colors.textMuted,
    textDecorationLine: 'line-through',
  },
  delete: {
    paddingHorizontal: space.xs,
  },
  deleteText: {
    color: colors.textMuted,
    fontSize: 24,
    lineHeight: 26,
  },
});
