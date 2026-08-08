import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, ExternalLink, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { lfgFetch } from "@/lib/lfg-client";

// Only speech-to-text remains; TTS/spoken replies were removed. Kept as a type
// (rather than inlined) so a future output capability slots back in cleanly.
export type VoiceCapability = "input";

type ProviderOption = {
  id: string;
  label: string;
  available: boolean;
  envVar: string;
  accountUrl: string;
};

export type VoiceConfig = {
  settings: { sttProvider: string };
  providers: { stt: ProviderOption[] };
  /** Dictation shows words as you speak. False = transcript only after the take. */
  streaming?: boolean;
  setup: { envFile: string; restartCommand: string };
};

/** True when dictation will only produce text after the take ends. The mic still
 * works; it just can't show a running transcript, and the UI should say so
 * rather than looking like it hung. */
export function voiceIsBatchOnly(cfg: VoiceConfig | null): boolean {
  return cfg?.streaming === false;
}

const SETUP_EVENT = "lfg:voice-setup";

function selectedProvider(cfg: VoiceConfig, _capability: VoiceCapability): ProviderOption | undefined {
  return cfg.providers.stt.find((provider) => provider.id === cfg.settings.sttProvider);
}

export function voiceReady(cfg: VoiceConfig, capability: VoiceCapability): boolean {
  return selectedProvider(cfg, capability)?.available === true;
}

export function showVoiceSetup(capability: VoiceCapability = "input") {
  window.dispatchEvent(new CustomEvent(SETUP_EVENT, { detail: { capability } }));
}

// ───────────────────────────────────────────────────────────────────────────
// Config cache.
//
// This check used to run as a blocking `fetch(..., {cache:"no-store"})` on every
// single mic tap, BEFORE the feature touched the microphone. Two ways that hurt:
//
//   * A slow/asleep backend (or a laggy tunnel) delayed getUserMedia by however
//     long the round trip took — so the browser's permission prompt appeared
//     seconds after the tap, looking like the app had hung.
//   * Awaiting an arbitrary-length network call between the user's tap and
//     getUserMedia burns the transient user activation that Safari/iOS (and an
//     installed PWA especially) require. The mic request then rejects outright
//     and the tap appears to do nothing.
//
// So: keep a short-lived cache, prefetch it at startup, and expose a SYNCHRONOUS
// read for the hot path. Callers can gate on what we already know without ever
// awaiting, and confirm afterwards.
const CONFIG_TTL_MS = 30_000;
let cached: { cfg: VoiceConfig; at: number } | null = null;
let inflight: Promise<VoiceConfig | null> | null = null;
// Bumped on every invalidation. A read that was already in flight when the
// config changed (e.g. it started before a key was saved) is stale by the time
// it lands, so it must not be shared with new callers or written to the cache.
let generation = 0;

async function fetchVoiceConfig(): Promise<VoiceConfig | null> {
  if (inflight) return inflight;
  const gen = generation;
  inflight = (async () => {
    try {
      const response = await lfgFetch("/api/voice/config", { cache: "no-store" });
      if (!response.ok) return null;
      const cfg = (await response.json()) as VoiceConfig;
      if (gen === generation) cached = { cfg, at: Date.now() };
      return cfg;
    } catch {
      return null;
    } finally {
      if (gen === generation) inflight = null;
    }
  })();
  return inflight;
}

/** Warm the cache so the first mic tap never has to wait on the network. */
export function prefetchVoiceConfig(): void {
  void fetchVoiceConfig();
}

/** Drop the cache — after saving a key, so the next check sees the new state. */
export function invalidateVoiceConfig(): void {
  cached = null;
  // Abandon any in-flight read too: it was issued against the old config and
  // would otherwise be handed to the very caller asking for the new one.
  generation += 1;
  inflight = null;
}

/**
 * Synchronous, non-blocking answer from cache.
 * `true` ready, `false` definitively not configured, `null` unknown (not cached
 * yet or stale) — treat `null` as "go ahead, verify afterwards".
 */
export function voiceConfiguredCached(capability: VoiceCapability): boolean | null {
  if (!cached) {
    prefetchVoiceConfig();
    return null;
  }
  if (Date.now() - cached.at > CONFIG_TTL_MS) {
    prefetchVoiceConfig(); // refresh in the background, answer from what we have
  }
  return voiceReady(cached.cfg, capability);
}

/** Synchronous, cache-only read of whether dictation is batch-only right now.
 * Unknown (nothing cached yet) reads as false so the UI never claims a downgrade
 * it hasn't confirmed. */
export function voiceBatchOnlyCached(): boolean {
  if (!cached) {
    prefetchVoiceConfig();
    return false;
  }
  return voiceIsBatchOnly(cached.cfg);
}

export async function ensureVoiceConfigured(capability: VoiceCapability): Promise<boolean> {
  const known = voiceConfiguredCached(capability);
  if (known !== null) {
    if (!known) showVoiceSetup(capability);
    return known;
  }
  const cfg = await fetchVoiceConfig();
  // A health-check network failure should not replace the feature's own error
  // handling. Only block when the server definitively reports a missing key.
  if (!cfg) return true;
  if (voiceReady(cfg, capability)) return true;
  showVoiceSetup(capability);
  return false;
}

export function VoiceSetupDialog() {
  const [open, setOpen] = useState(false);
  const [capability, setCapability] = useState<VoiceCapability>("input");
  const [cfg, setCfg] = useState<VoiceConfig | null>(null);
  const [providerId, setProviderId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    // Always a fresh read here (the dialog is where keys change), and it seeds
    // the shared cache so the next mic tap answers instantly.
    invalidateVoiceConfig();
    const next = await fetchVoiceConfig();
    if (!next) throw new Error("Could not check voice configuration");
    setCfg(next);
    return next;
  }, []);

  // Warm the shared config cache as soon as the app mounts (this dialog lives at
  // the root). By the time anyone taps the mic the answer is already local, so
  // the gate costs nothing and the permission prompt fires on the tap itself.
  useEffect(() => {
    prefetchVoiceConfig();
  }, []);

  useEffect(() => {
    const onSetup = (event: Event) => {
      const detail = (event as CustomEvent<{ capability?: VoiceCapability }>).detail;
      const nextCapability = detail?.capability ?? "input";
      setCapability(nextCapability);
      setApiKey("");
      setMessage("");
      setOpen(true);
      void load()
        .then((next) => {
          const preferred = selectedProvider(next, nextCapability);
          setProviderId(preferred?.id ?? next.providers.stt[0]?.id ?? "");
        })
        .catch((error) => setMessage(error instanceof Error ? error.message : String(error)));
    };
    window.addEventListener(SETUP_EVENT, onSetup);
    return () => window.removeEventListener(SETUP_EVENT, onSetup);
  }, [load]);

  const providers = useMemo(() => {
    if (!cfg) return [];
    const combined = cfg.providers.stt;
    return [...new Map(combined.map((provider) => [provider.id, provider])).values()];
  }, [capability, cfg]);
  const provider = providers.find((item) => item.id === providerId) ?? providers[0];

  const saveKey = async () => {
    if (!provider || !apiKey.trim()) return;
    setSaving(true);
    setMessage("");
    try {
      const selection = { sttProvider: provider.id };
      const response = await lfgFetch("/api/voice/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId: provider.id, apiKey: apiKey.trim(), ...selection }),
      });
      const result = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) throw new Error(result?.error || "Could not save the API key");
      const next = await load();
      setApiKey("");
      if (voiceReady(next, capability)) {
        setMessage("API key saved. Voice messages are ready.");
        window.setTimeout(() => setOpen(false), 700);
      } else {
        setMessage("API key saved, but this voice configuration is not ready yet.");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <div className="mb-1 flex size-10 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <KeyRound className="size-5" />
          </div>
          <DialogTitle>Set up voice messages</DialogTitle>
          <DialogDescription>
            Voice messages need a speech-to-text API key.
          </DialogDescription>
        </DialogHeader>

        {providers.length > 1 ? (
          <div className="flex gap-2" aria-label="Voice provider">
            {providers.map((item) => (
              <Button
                key={item.id}
                type="button"
                size="sm"
                variant={item.id === provider?.id ? "default" : "outline"}
                onClick={() => setProviderId(item.id)}
              >
                {item.available ? <Check className="size-3.5" /> : null}
                {item.label.replace(/ \(.+\)$/, "")}
              </Button>
            ))}
          </div>
        ) : null}

        {provider && cfg ? (
          <div className="space-y-4 text-sm">
            <div className="space-y-2">
              <p>Create or copy a {provider.label.replace(/ \(.+\)$/, "")} API key.</p>
              <Button variant="outline" size="sm" render={<a href={provider.accountUrl} target="_blank" rel="noreferrer" />}>
                Open API keys <ExternalLink className="size-3.5" />
              </Button>
            </div>
            <div className="space-y-2">
              <label htmlFor="voice-api-key" className="font-medium">API key</label>
              <Input
                id="voice-api-key"
                type="password"
                value={apiKey}
                autoComplete="off"
                placeholder={provider.available ? "Enter a new key to replace the current one" : "Paste your API key"}
                onChange={(event) => setApiKey(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void saveKey();
                }}
              />
              <p className="text-xs text-muted-foreground">
                Saved securely to the server environment. The key is never sent back to the browser.
              </p>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Loading voice providers…</p>
        )}

        {message ? <p role="status" className="text-sm text-muted-foreground">{message}</p> : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>Not now</Button>
          <Button type="button" disabled={saving || !cfg || !provider || !apiKey.trim()} onClick={() => void saveKey()}>
            {saving ? "Saving…" : "Save API key"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
