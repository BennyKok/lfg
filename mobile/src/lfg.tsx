import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from "react";

export type Message = {
  id?: string;
  role?: string;
  kind?: string;
  text?: string;
  ts?: number;
  url?: string;
  artifactId?: string;
  caption?: string;
  pending?: boolean;
};
export type Session = {
  sessionId: string | null;
  nativeSessionId?: string | null;
  title?: string | null;
  lastUserText?: string | null;
  agent?: string;
  model?: string | null;
  project?: string | null;
  assignedUser?: string | null;
  busy?: boolean;
  status?: "ok" | "blocked";
  lastActivityAt?: number | null;
  startedAt?: number | null;
  last?: Message;
};
export type Boot = {
  version?: string;
  sessions: Session[] | null;
  repos: { name: string; cwd: string }[] | null;
  users: { email: string; name?: string }[] | null;
  codingAgents:
    | {
        key: string;
        label: string;
        visible?: boolean;
        status?: { configured?: boolean };
      }[]
    | null;
  models: { key: string; defaultModel?: string; models?: string[] }[] | null;
  auto?: {
    findings?:
      | { id: string; title: string; summary?: string; suggest?: string }[]
      | null;
  };
};

const KEY = "lfg:native:url";
const USER_KEY = "lfg:native:user";
const clean = (value: string) => value.trim().replace(/\/+$/, "");
const initialUrl = () => {
  if (process.env.EXPO_PUBLIC_LFG_URL)
    return clean(process.env.EXPO_PUBLIC_LFG_URL);
  const host = Constants.expoConfig?.hostUri?.split(":")[0];
  return host ? `http://${host}:8766` : "http://127.0.0.1:8766";
};
type Value = {
  baseUrl: string;
  boot: Boot | null;
  loading: boolean;
  error: string | null;
  userEmail: string | null;
  setBaseUrl: (url: string) => Promise<void>;
  setUserEmail: (email: string) => Promise<void>;
  refresh: () => Promise<void>;
  api: <T>(path: string, init?: RequestInit) => Promise<T>;
  absolute: (path: string) => string;
};
const Context = createContext<Value | null>(null);

export function LfgProvider({ children }: PropsWithChildren) {
  const [baseUrl, setUrl] = useState(initialUrl);
  const [ready, setReady] = useState(false);
  const [boot, setBoot] = useState<Boot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [userEmail, setUserState] = useState<string | null>(null);
  useEffect(() => {
    Promise.all([AsyncStorage.getItem(KEY), AsyncStorage.getItem(USER_KEY)])
      .then(([url, user]) => {
        if (url) setUrl(clean(url));
        if (user) setUserState(user);
      })
      .finally(() => setReady(true));
  }, []);
  const absolute = useCallback(
    (path: string) => `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`,
    [baseUrl],
  );
  const api = useCallback(
    async <T,>(path: string, init?: RequestInit) => {
      const response = await fetch(absolute(path), init);
      const data = await response.json().catch(() => ({}));
      if (!response.ok)
        throw new Error(
          data?.error || `${response.status} ${response.statusText}`,
        );
      return data as T;
    },
    [absolute],
  );
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setBoot(await api<Boot>("/api/bootstrap"));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [api]);
  const setBaseUrl = useCallback(async (url: string) => {
    const next = clean(url);
    setUrl(next);
    setBoot(null);
    await AsyncStorage.setItem(KEY, next);
  }, []);
  const setUserEmail = useCallback(async (email: string) => {
    setUserState(email);
    await AsyncStorage.setItem(USER_KEY, email);
  }, []);
  useEffect(() => {
    if (ready) void refresh();
  }, [ready, baseUrl, refresh]);
  const value = useMemo(
    () => ({
      baseUrl,
      boot,
      loading,
      error,
      userEmail,
      setBaseUrl,
      setUserEmail,
      refresh,
      api,
      absolute,
    }),
    [
      baseUrl,
      boot,
      loading,
      error,
      userEmail,
      setBaseUrl,
      setUserEmail,
      refresh,
      api,
      absolute,
    ],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export const useLfg = () => {
  const value = useContext(Context);
  if (!value) throw new Error("useLfg must be inside LfgProvider");
  return value;
};
