import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useState } from 'react';

export type Todo = {
  id: string;
  title: string;
  done: boolean;
  createdAt: number;
};

export type Filter = 'all' | 'active' | 'done';

const STORAGE_KEY = 'lfg-todo:v1';

function parseTodos(raw: string | null): Todo[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (t): t is Todo =>
        !!t &&
        typeof t.id === 'string' &&
        typeof t.title === 'string' &&
        typeof t.done === 'boolean' &&
        typeof t.createdAt === 'number',
    );
  } catch {
    return [];
  }
}

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

export function useTodos() {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [loaded, setLoaded] = useState(false);

  // Load once on mount.
  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(STORAGE_KEY)
      .then((raw) => {
        if (cancelled) return;
        setTodos(parseTodos(raw));
      })
      .catch(() => {
        // Storage unavailable — start empty rather than crashing.
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist on every change, but only after the initial load so we never
  // overwrite stored todos with the empty bootstrap state.
  useEffect(() => {
    if (!loaded) return;
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(todos)).catch(() => {});
  }, [todos, loaded]);

  const addTodo = useCallback((title: string) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    setTodos((prev) => [
      { id: nextId(), title: trimmed, done: false, createdAt: Date.now() },
      ...prev,
    ]);
  }, []);

  const toggleTodo = useCallback((id: string) => {
    setTodos((prev) =>
      prev.map((t) => (t.id === id ? { ...t, done: !t.done } : t)),
    );
  }, []);

  const removeTodo = useCallback((id: string) => {
    setTodos((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const clearDone = useCallback(() => {
    setTodos((prev) => prev.filter((t) => !t.done));
  }, []);

  return { todos, loaded, addTodo, toggleTodo, removeTodo, clearDone };
}
