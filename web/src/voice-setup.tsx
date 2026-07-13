import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, ExternalLink, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
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

function command(text: string) {
  return (
    <code className="block overflow-x-auto rounded-xl bg-muted px-3 py-2 text-xs text-foreground">
      {text}
    </code>
  );
}

export function VoiceSetupDialog() {
  const [open, setOpen] = useState(false);
  const [capability, setCapability] = useState<VoiceCapability>("call");
  const [cfg, setCfg] = useState<VoiceConfig | null>(null);
  const [providerId, setProviderId] = useState("");
  const [checking, setChecking] = useState(false);
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

  const checkAgain = async () => {
    setChecking(true);
    setMessage("");
    try {
      const next = await load();
      if (voiceReady(next, capability)) {
        setMessage("Voice is configured. You can try again now.");
        window.setTimeout(() => setOpen(false), 700);
      } else {
        setMessage("The key is still not available. Save .env and restart LFG, then check again.");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setChecking(false);
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
          <ol className="space-y-4 text-sm">
            <li className="space-y-2">
              <p><span className="mr-2 font-semibold">1.</span>Create or copy a {provider.label.replace(/ \(.+\)$/, "")} API key.</p>
              <Button variant="outline" size="sm" render={<a href={provider.accountUrl} target="_blank" rel="noreferrer" />}>
                Open API keys <ExternalLink className="size-3.5" />
              </Button>
            </li>
            <li className="space-y-2">
              <p><span className="mr-2 font-semibold">2.</span>Add the key to the server environment file.</p>
              {command(`${provider.envVar}=your_key_here`)}
              <p className="break-all text-xs text-muted-foreground">{cfg.setup.envFile}</p>
            </li>
            <li className="space-y-2">
              <p><span className="mr-2 font-semibold">3.</span>Restart LFG so it loads the new key.</p>
              {command(cfg.setup.restartCommand)}
            </li>
            <li>
              <p><span className="mr-2 font-semibold">4.</span>Return here and check the setup.</p>
            </li>
          </ol>
        ) : (
          <p className="text-sm text-muted-foreground">Loading voice providers…</p>
        )}

        {message ? <p role="status" className="text-sm text-muted-foreground">{message}</p> : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>Not now</Button>
          <Button type="button" disabled={checking || !cfg} onClick={() => void checkAgain()}>
            {checking ? "Checking…" : "I restarted — check again"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
