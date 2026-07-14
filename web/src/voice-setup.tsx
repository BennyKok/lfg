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

export type VoiceCapability = "input" | "output" | "call";

type ProviderOption = {
  id: string;
  label: string;
  available: boolean;
  envVar: string;
  accountUrl: string;
};

export type VoiceConfig = {
  settings: { ttsProvider: string; sttProvider: string };
  providers: { tts: ProviderOption[]; stt: ProviderOption[] };
  setup: { envFile: string; restartCommand: string };
};

const SETUP_EVENT = "lfg:voice-setup";

function selectedProvider(
  cfg: VoiceConfig,
  capability: Exclude<VoiceCapability, "call">,
): ProviderOption | undefined {
  const kind = capability === "input" ? "stt" : "tts";
  const selected = capability === "input" ? cfg.settings.sttProvider : cfg.settings.ttsProvider;
  return cfg.providers[kind].find((provider) => provider.id === selected);
}

export function voiceReady(cfg: VoiceConfig, capability: VoiceCapability): boolean {
  if (capability === "call") {
    return voiceReady(cfg, "input") && voiceReady(cfg, "output");
  }
  return selectedProvider(cfg, capability)?.available === true;
}

export function showVoiceSetup(capability: VoiceCapability = "call") {
  window.dispatchEvent(new CustomEvent(SETUP_EVENT, { detail: { capability } }));
}

export async function ensureVoiceConfigured(capability: VoiceCapability): Promise<boolean> {
  try {
    const response = await fetch("/api/voice/config", { cache: "no-store" });
    if (!response.ok) return true;
    const cfg = (await response.json()) as VoiceConfig;
    if (voiceReady(cfg, capability)) return true;
    showVoiceSetup(capability);
    return false;
  } catch {
    // A health-check network failure should not replace the feature's own error
    // handling. Only block when the server definitively reports a missing key.
    return true;
  }
}

export function VoiceSetupDialog() {
  const [open, setOpen] = useState(false);
  const [capability, setCapability] = useState<VoiceCapability>("call");
  const [cfg, setCfg] = useState<VoiceConfig | null>(null);
  const [providerId, setProviderId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    const response = await fetch("/api/voice/config", { cache: "no-store" });
    if (!response.ok) throw new Error("Could not check voice configuration");
    const next = (await response.json()) as VoiceConfig;
    setCfg(next);
    return next;
  }, []);

  useEffect(() => {
    const onSetup = (event: Event) => {
      const detail = (event as CustomEvent<{ capability?: VoiceCapability }>).detail;
      const nextCapability = detail?.capability ?? "call";
      setCapability(nextCapability);
      setApiKey("");
      setMessage("");
      setOpen(true);
      void load()
        .then((next) => {
          const preferred = selectedProvider(
            next,
            nextCapability === "output" ? "output" : "input",
          );
          setProviderId(preferred?.id ?? next.providers.stt[0]?.id ?? "");
        })
        .catch((error) => setMessage(error instanceof Error ? error.message : String(error)));
    };
    window.addEventListener(SETUP_EVENT, onSetup);
    return () => window.removeEventListener(SETUP_EVENT, onSetup);
  }, [load]);

  const providers = useMemo(() => {
    if (!cfg) return [];
    const combined = capability === "output" ? cfg.providers.tts : cfg.providers.stt;
    return [...new Map(combined.map((provider) => [provider.id, provider])).values()];
  }, [capability, cfg]);
  const provider = providers.find((item) => item.id === providerId) ?? providers[0];

  const saveKey = async () => {
    if (!provider || !apiKey.trim()) return;
    setSaving(true);
    setMessage("");
    try {
      const selection = capability === "input"
        ? { sttProvider: provider.id }
        : capability === "output"
          ? { ttsProvider: provider.id }
          : { sttProvider: provider.id, ttsProvider: provider.id };
      const response = await fetch("/api/voice/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId: provider.id, apiKey: apiKey.trim(), ...selection }),
      });
      const result = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) throw new Error(result?.error || "Could not save the API key");
      const next = await load();
      setApiKey("");
      if (voiceReady(next, capability)) {
        setMessage("API key saved. Voice is ready to use.");
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
          <DialogTitle>Set up voice</DialogTitle>
          <DialogDescription>
            {capability === "input"
              ? "Voice messages need a speech-to-text API key."
              : capability === "output"
                ? "Spoken replies need a text-to-speech API key."
                : "Voice calls need a configured speech provider before they can start."}
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
