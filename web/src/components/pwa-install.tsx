import { useState } from "react";
import { Download, Share, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { usePwaInstall, type PwaInstallMode } from "@/lib/pwa-install";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/notify";

const CALLOUT_DISMISSED_KEY = "lfg_pwa_install_callout_dismissed";

function initiallyDismissed() {
  try {
    return sessionStorage.getItem(CALLOUT_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

function InstallInstructions({ mode, open, onOpenChange }: {
  mode: PwaInstallMode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const ios = mode === "ios";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <div className="mb-2 flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            {ios ? <Share className="size-7" /> : <Download className="size-7" />}
          </div>
          <DialogTitle>{ios ? "Install lfg on your Home Screen" : "Install lfg on your Mac"}</DialogTitle>
          <DialogDescription>
            {ios
              ? "Open lfg like an app, without browser controls."
              : "Add lfg to your Dock and open it in its own window."}
          </DialogDescription>
        </DialogHeader>
        <ol className="space-y-3">
          {(ios
            ? [
                <>Tap the <strong>Share</strong> button in your browser.</>,
                <>Choose <strong>Add to Home Screen</strong>.</>,
                <>Keep <strong>Open as Web App</strong> on, then tap <strong>Add</strong>.</>,
              ]
            : [
                <>Open the <strong>File</strong> menu in Safari.</>,
                <>Choose <strong>Add to Dock…</strong>.</>,
                <>Confirm the name, then click <strong>Add</strong>.</>,
              ]
          ).map((step, index) => (
            <li key={index} className="flex items-start gap-3 text-sm">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
                {index + 1}
              </span>
              <span className="pt-0.5">{step}</span>
            </li>
          ))}
        </ol>
        <Button onClick={() => onOpenChange(false)}>Got it</Button>
      </DialogContent>
    </Dialog>
  );
}

function useInstallAction(mode: PwaInstallMode, install: () => Promise<boolean>) {
  const [instructionsOpen, setInstructionsOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const act = async () => {
    if (mode !== "native") {
      setInstructionsOpen(true);
      return;
    }
    if (busy) return;
    setBusy(true);
    try {
      const installed = await install();
      if (installed) toast.success("lfg installed");
    } catch {
      toast.error("Could not open the install prompt");
    } finally {
      setBusy(false);
    }
  };

  return { act, busy, instructionsOpen, setInstructionsOpen };
}

export function PwaInstallCallout() {
  const { installed, mode, install } = usePwaInstall();
  const [dismissed, setDismissed] = useState(initiallyDismissed);
  const action = useInstallAction(mode, install);

  if (installed || mode === "none" || dismissed) return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      sessionStorage.setItem(CALLOUT_DISMISSED_KEY, "1");
    } catch {
      // Storage can be disabled; dismissing for this render is still enough.
    }
  };

  return (
    <>
      <aside className="mx-3 mt-2 flex items-center gap-3 rounded-2xl border border-primary/20 bg-card/90 px-3 py-2.5 shadow-sm backdrop-blur-xl">
        <img src="/icon.svg" alt="" className="size-10 shrink-0 rounded-xl" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">Install lfg</div>
          <div className="truncate text-xs text-muted-foreground">
            Faster launch, its own window, and a home-screen icon.
          </div>
        </div>
        <Button size="sm" onClick={() => void action.act()} disabled={action.busy}>
          <Download className="size-4" />
          {mode === "native" ? "Install" : "How"}
        </Button>
        <Button size="icon-xs" variant="ghost" onClick={dismiss} aria-label="Dismiss install suggestion">
          <X className="size-3.5" />
        </Button>
      </aside>
      <InstallInstructions mode={mode} open={action.instructionsOpen} onOpenChange={action.setInstructionsOpen} />
    </>
  );
}

export function PwaInstallSettingsSection() {
  const { installed, mode, install } = usePwaInstall();
  const action = useInstallAction(mode, install);

  if (installed || mode === "none") return null;

  return (
    <>
      <section className="space-y-2">
        <h2 className="px-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          App
        </h2>
        <div className="overflow-hidden rounded-2xl border border-border bg-card/40">
          <button
            type="button"
            onClick={() => void action.act()}
            disabled={action.busy}
            className={cn(
              "flex w-full items-center justify-between gap-4 px-4 py-2.5 text-left transition-colors duration-150 ease-ios hover:bg-foreground/[0.03] active:bg-foreground/[0.06]",
              action.busy && "opacity-50",
            )}
          >
            <div className="flex items-center gap-3">
              <span className="flex size-7 items-center justify-center rounded-[7px] bg-primary text-white">
                <Download className="size-4" />
              </span>
              <span>
                <span className="block text-sm font-medium">Install lfg</span>
                <span className="block text-xs text-muted-foreground">Open it from your desktop or Home Screen</span>
              </span>
            </div>
          </button>
        </div>
      </section>
      <InstallInstructions mode={mode} open={action.instructionsOpen} onOpenChange={action.setInstructionsOpen} />
    </>
  );
}
