import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ClipboardPaste, CornerDownLeft, Delete, Loader2, RotateCcw, Save, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { appWebSocketUrl } from "@/lib/base-path";

// Live, interactive remote-browser view. We open a WebSocket to the backend
// session stream, paint incoming JPEG frames onto a <canvas>, and forward the
// user's mouse/keyboard into the headless browser. Coordinates are sent in CSS
// px relative to the canvas (the backend maps them to the real viewport).
//
// server -> client:
//   { type:'frame', dataB64, w, h }
//   { type:'status', state, url, title }
//   { type:'saved', profileId }
//   { type:'error', message }
// client -> server:
//   { type:'input', kind, x?, y?, button?, deltaY?, key?, text? }
//   { type:'navigate', url }
//   { type:'save', name }
//   { type:'reload' }

type FrameMsg = { type: "frame"; dataB64: string; w: number; h: number };
type StatusMsg = {
  type: "status";
  state?: string;
  url?: string;
  title?: string;
};
type SavedMsg = { type: "saved"; profileId: string };
type ErrorMsg = { type: "error"; message: string };
type ServerMsg = FrameMsg | StatusMsg | SavedMsg | ErrorMsg;

type ConnState = "connecting" | "open" | "closed" | "error";

export default function BrowserLoginView(props: {
  sessionId: string;
  onClose: () => void;
  onSaved?: (profileId: string) => void;
}) {
  const { sessionId, onClose, onSaved } = props;

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  // Latest known frame dimensions, so we keep the canvas backing store sized to
  // the remote viewport for crisp 1:1 painting.
  const frameSizeRef = useRef<{ w: number; h: number }>({ w: 1280, h: 800 });

  const [conn, setConn] = useState<ConnState>("connecting");
  const [status, setStatus] = useState<{
    state?: string;
    url?: string;
    title?: string;
  }>({});
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [addressBar, setAddressBar] = useState("");
  const [saving, setSaving] = useState(false);
  // Mobile soft-keyboard + paste bridge: a real <input> the OS keyboard binds to.
  const [keyEntry, setKeyEntry] = useState("");
  const entryRef = useRef<HTMLInputElement | null>(null);

  const send = useCallback((msg: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }, []);

  // --- WebSocket lifecycle ---------------------------------------------------
  useLayoutEffect(() => {
    let disposed = false;
    const url = appWebSocketUrl(`/api/browser/sessions/${encodeURIComponent(
      sessionId,
    )}/stream`);
    const ws = new WebSocket(url);
    wsRef.current = ws;
    setConn("connecting");

    ws.onopen = () => {
      if (disposed) return;
      setConn("open");
    };

    ws.onmessage = (e) => {
      if (disposed) return;
      if (typeof e.data !== "string") return;
      let msg: ServerMsg;
      try {
        msg = JSON.parse(e.data) as ServerMsg;
      } catch {
        return;
      }
      switch (msg.type) {
        case "frame":
          paintFrame(msg);
          break;
        case "status":
          setStatus({ state: msg.state, url: msg.url, title: msg.title });
          if (msg.url) setAddressBar((cur) => (cur ? cur : msg.url ?? ""));
          break;
        case "saved":
          setSaving(false);
          toast.success("Profile saved");
          onSaved?.(msg.profileId);
          break;
        case "error":
          setSaving(false);
          setErrorMsg(msg.message);
          toast.error(msg.message || "Browser session error");
          break;
      }
    };

    ws.onerror = () => {
      if (disposed) return;
      setConn("error");
      setErrorMsg("Connection error");
    };

    ws.onclose = () => {
      if (disposed) return;
      setConn("closed");
    };

    return () => {
      disposed = true;
      wsRef.current = null;
      try {
        ws.close();
      } catch {
        // ignore
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Draw a base64 JPEG frame onto the canvas, keeping the backing store sized to
  // the remote viewport.
  const paintFrame = useCallback((frame: FrameMsg) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (frame.w && frame.h) {
      frameSizeRef.current = { w: frame.w, h: frame.h };
      if (canvas.width !== frame.w) canvas.width = frame.w;
      if (canvas.height !== frame.h) canvas.height = frame.h;
    }
    let ctx = ctxRef.current;
    if (!ctx) {
      ctx = canvas.getContext("2d");
      ctxRef.current = ctx;
    }
    if (!ctx) return;
    const img = new Image();
    img.onload = () => {
      const c = canvasRef.current;
      const cx = ctxRef.current;
      if (!c || !cx) return;
      cx.drawImage(img, 0, 0, c.width, c.height);
    };
    img.src = `data:image/jpeg;base64,${frame.dataB64}`;
  }, []);

  // --- Input forwarding ------------------------------------------------------
  // Translate a DOM mouse event into canvas-viewport CSS px. The canvas is
  // displayed scaled to fit; we map the on-screen position back to the remote
  // viewport's coordinate space (matching the frame dimensions).
  const toViewport = useCallback((e: { clientX: number; clientY: number }) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const { w, h } = frameSizeRef.current;
    const sx = rect.width > 0 ? w / rect.width : 1;
    const sy = rect.height > 0 ? h / rect.height : 1;
    const x = Math.round((e.clientX - rect.left) * sx);
    const y = Math.round((e.clientY - rect.top) * sy);
    return { x, y };
  }, []);

  const onMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const { x, y } = toViewport(e);
      send({ type: "input", kind: "mousemove", x, y });
    },
    [send, toViewport],
  );

  const onMouseDown = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      canvasRef.current?.focus();
      const { x, y } = toViewport(e);
      send({ type: "input", kind: "mousedown", x, y, button: e.button });
    },
    [send, toViewport],
  );

  const onMouseUp = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const { x, y } = toViewport(e);
      send({ type: "input", kind: "mouseup", x, y, button: e.button });
    },
    [send, toViewport],
  );

  const onWheel = useCallback(
    (e: React.WheelEvent<HTMLCanvasElement>) => {
      const { x, y } = toViewport(e);
      send({ type: "input", kind: "wheel", x, y, deltaY: e.deltaY });
    },
    [send, toViewport],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLCanvasElement>) => {
      // Keep focus & the remote browser in control of all keys.
      e.preventDefault();
      send({ type: "input", kind: "keydown", key: e.key });
      // For printable characters, also forward an insertText so the remote page
      // receives the actual typed text (covers IME/shift/layout differences).
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        send({ type: "input", kind: "char", text: e.key });
      }
    },
    [send],
  );

  const onKeyUp = useCallback(
    (e: React.KeyboardEvent<HTMLCanvasElement>) => {
      e.preventDefault();
      send({ type: "input", kind: "keyup", key: e.key });
    },
    [send],
  );

  // Forward a paste (Cmd/Ctrl+V) into the remote browser. The keydown for the
  // paste shortcut still fires (with ctrl/meta held, so it sends no char), and
  // the browser then emits this paste event with the clipboard contents — we
  // insert that text via the existing "char" path (CDP Input.insertText).
  const onPaste = useCallback(
    (e: React.ClipboardEvent<HTMLCanvasElement>) => {
      e.preventDefault();
      const text = e.clipboardData.getData("text/plain");
      if (text) send({ type: "input", kind: "char", text });
    },
    [send],
  );

  // --- Text/key injection (works on mobile, where the canvas can't) ----------
  // Inject literal text into whatever field is focused in the remote page.
  const sendText = useCallback(
    (text: string) => {
      if (text) send({ type: "input", kind: "char", text });
    },
    [send],
  );

  // Tap-able special keys (Enter to submit, Tab to move fields, Backspace).
  const sendKey = useCallback(
    (key: string) => {
      send({ type: "input", kind: "keydown", key });
      send({ type: "input", kind: "keyup", key });
    },
    [send],
  );

  // Flush the bridge input into the page, then clear + refocus for the next field.
  const sendEntry = useCallback(() => {
    if (!keyEntry) return;
    sendText(keyEntry);
    setKeyEntry("");
    entryRef.current?.focus();
  }, [keyEntry, sendText]);

  // One-tap paste. Uses the async Clipboard API when available (secure context);
  // over plain http (e.g. Tailscale) that API is blocked, so we fall back to
  // focusing the bridge input and letting the OS long-press-paste into it.
  const pasteFromClipboard = useCallback(async () => {
    try {
      const text = await navigator.clipboard?.readText?.();
      if (text) {
        sendText(text);
        toast.success("Pasted into page");
        return;
      }
      if (text === "") {
        toast.message("Clipboard is empty");
        return;
      }
      throw new Error("no clipboard api");
    } catch {
      entryRef.current?.focus();
      toast.message("Paste into the text box, then tap Send");
    }
  }, [sendText]);

  // --- Toolbar actions -------------------------------------------------------
  const submitAddress = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const raw = addressBar.trim();
      if (!raw) return;
      const url = /^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`;
      send({ type: "navigate", url });
    },
    [addressBar, send],
  );

  const handleSave = useCallback(() => {
    const name = window.prompt("Save profile as:", status.title || "");
    if (name == null) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    setSaving(true);
    send({ type: "save", name: trimmed });
  }, [send, status.title]);

  const handleReload = useCallback(() => {
    send({ type: "reload" });
  }, [send]);

  const handleClose = useCallback(() => {
    try {
      wsRef.current?.close();
    } catch {
      // ignore
    }
    onClose();
  }, [onClose]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5 bg-background text-foreground">
      {/* Toolbar — rows stack on narrow screens so nothing gets crushed. */}
      <div className="flex shrink-0 flex-col gap-1.5 border-b border-border px-3 py-2">
        <form onSubmit={submitAddress} className="flex min-w-0 items-center gap-2">
          <input
            type="url"
            aria-label="Browser address"
            inputMode="url"
            value={addressBar}
            onChange={(e) => setAddressBar(e.target.value)}
            placeholder="Enter a URL to navigate"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="min-w-0 flex-1 rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
          />
          <Button type="submit" size="sm" variant="outline">
            Go
          </Button>
        </form>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={handleReload} title="Reload page" aria-label="Reload">
            <RotateCcw className="size-4" />
            <span className="ml-1 hidden sm:inline">Reload</span>
          </Button>
          <Button size="sm" variant="brand" onClick={handleSave} disabled={saving} title="Save profile" aria-label="Save profile">
            {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
            <span className="ml-1 hidden sm:inline">Save profile</span>
          </Button>
          <Button size="sm" variant="ghost" onClick={handleClose} className="ml-auto" title="Close" aria-label="Close">
            <X className="size-4" />
            <span className="ml-1 hidden sm:inline">Close</span>
          </Button>
        </div>
      </div>

      {/* Keyboard + paste bridge — the canvas can't open a mobile keyboard or
          accept paste, so this real input injects text/keys into the focused
          field in the remote page. Tap a field in the page first. */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-3">
        <input
          ref={entryRef}
          type="text"
          aria-label="Remote browser keyboard input"
          value={keyEntry}
          onChange={(e) => setKeyEntry(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              sendEntry();
            }
          }}
          placeholder="Type or paste, then Send"
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1 basis-44 rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
        />
        <Button size="sm" variant="brand" onClick={sendEntry} disabled={!keyEntry}>
          Send
        </Button>
        <Button size="sm" variant="outline" onClick={pasteFromClipboard} title="Paste from clipboard" aria-label="Paste">
          <ClipboardPaste className="size-4" />
          <span className="ml-1 hidden sm:inline">Paste</span>
        </Button>
        <Button size="sm" variant="outline" onClick={() => sendKey("Enter")} title="Press Enter in page" aria-label="Enter">
          <CornerDownLeft className="size-4" />
        </Button>
        {/* Tab is a niche helper — drop it on phones to keep the row compact. */}
        <Button size="sm" variant="outline" onClick={() => sendKey("Tab")} title="Press Tab in page" aria-label="Tab" className="hidden sm:inline-flex">
          <span className="text-xs font-medium">Tab</span>
        </Button>
        <Button size="sm" variant="outline" onClick={() => sendKey("Backspace")} title="Backspace in page" aria-label="Backspace">
          <Delete className="size-4" />
        </Button>
      </div>

      {/* Status line */}
      <div className="flex shrink-0 items-center gap-2 px-3 text-xs text-muted-foreground">
        <span
          className={
            "inline-block size-2 shrink-0 rounded-full " +
            (conn === "open"
              ? "bg-emerald-500"
              : conn === "connecting"
                ? "bg-amber-500"
                : "bg-destructive")
          }
          title={conn}
        />
        <span className="min-w-0 max-w-[50%] shrink-0 truncate">
          {status.title ? status.title : status.state || conn}
        </span>
        {status.url ? (
          <span className="min-w-0 flex-1 truncate text-muted-foreground/70">
            · {status.url}
          </span>
        ) : null}
      </div>

      {errorMsg ? (
        <div className="mx-3 shrink-0 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
          {errorMsg}
        </div>
      ) : null}

      {/* Canvas viewport */}
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black/80 p-2">
        <canvas
          ref={canvasRef}
          tabIndex={0}
          width={frameSizeRef.current.w}
          height={frameSizeRef.current.h}
          onMouseMove={onMouseMove}
          onMouseDown={onMouseDown}
          onMouseUp={onMouseUp}
          onWheel={onWheel}
          onContextMenu={(e) => e.preventDefault()}
          onKeyDown={onKeyDown}
          onKeyUp={onKeyUp}
          onPaste={onPaste}
          className="max-h-full max-w-full cursor-crosshair rounded-md shadow-lg outline-none"
          style={{ touchAction: "none" }}
        />
      </div>
    </div>
  );
}
