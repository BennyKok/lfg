// The Terminal tab: a faithful browser terminal — ghostty-web (Ghostty's real
// VT engine compiled to WASM) bridged over a websocket to a persistent tmux
// shell on the box. ghostty-web renders Claude Code's heavy TUI faithfully where
// xterm.js mangles it, which is the case we mostly care about here.
import { useCallback, useEffect, useRef, useState } from "react";
import type { TouchEvent as ReactTouchEvent } from "react";
import { init, Terminal as GhosttyTerminal, FitAddon } from "ghostty-web";
import { Check, ClipboardPaste, Copy, ExternalLink, Keyboard, KeyboardOff, TerminalSquare, X } from "lucide-react";

// One WASM load per page, shared across mount/unmount of the tab.
let ghosttyReady: Promise<void> | null = null;
const ensureGhostty = () => (ghosttyReady ??= init());

// Merge freshly-seen URLs into the running list, most-recent first, deduped and
// capped. `found` is chronological, so unshifting in order leaves the newest at
// the front. Returns `prev` unchanged when nothing moved (so React can bail).
function mergeUrls(prev: string[], found: string[], cap = 8): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = found.length - 1; i >= 0; i--) {
    const u = found[i];
    if (!seen.has(u)) {
      seen.add(u);
      out.push(u);
    }
  }
  for (const u of prev) {
    if (!seen.has(u)) {
      seen.add(u);
      out.push(u);
    }
  }
  const next = out.slice(0, cap);
  return next.length === prev.length && next.every((u, i) => u === prev[i]) ? prev : next;
}

// Raw byte sequences for the on-screen key toolbar (phones can't send these).
const KEYS = {
  esc: "\x1b",
  tab: "\t",
  ctrlC: "\x03",
  up: "\x1b[A",
  down: "\x1b[B",
  left: "\x1b[D",
  right: "\x1b[C",
  enter: "\r",
};

type TerminalInstance = InstanceType<typeof GhosttyTerminal>;
type GhosttyWithInput = TerminalInstance & {
  element?: HTMLElement;
  textarea?: HTMLTextAreaElement;
};

function terminalInput(term: TerminalInstance | null) {
  return (term as GhosttyWithInput | null)?.textarea ?? null;
}

function focusTerminalKeyboard(term: TerminalInstance | null) {
  if (!term) return;
  term.focus();
  // Mobile browsers are more reliable about opening the soft keyboard for a
  // real text input than for Ghostty's contenteditable/canvas wrapper.
  terminalInput(term)?.focus();
}

function blurTerminalKeyboard(term: TerminalInstance | null) {
  terminalInput(term)?.blur();
  term?.blur();
}

function mouseTrackingMode(term: TerminalInstance) {
  try {
    const button = term.getMode(1000) || term.getMode(1002) || term.getMode(1003);
    const enabled = term.hasMouseTracking() || button;
    return {
      enabled,
      button: enabled,
      drag: term.getMode(1002) || term.getMode(1003),
      any: term.getMode(1003),
      sgr: term.getMode(1006),
    };
  } catch {
    return { enabled: false, button: false, drag: false, any: false, sgr: false };
  }
}

function mouseCell(term: TerminalInstance, clientX: number, clientY: number) {
  const renderer = term.renderer;
  const canvas = renderer?.getCanvas();
  if (!renderer || !canvas || !renderer.charWidth || !renderer.charHeight) return null;
  const rect = canvas.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  if (x < 0 || y < 0 || x >= rect.width || y >= rect.height) return null;
  return {
    col: Math.max(1, Math.min(term.cols, Math.floor(x / renderer.charWidth) + 1)),
    row: Math.max(1, Math.min(term.rows, Math.floor(y / renderer.charHeight) + 1)),
  };
}

function eventMods(e: MouseEvent | WheelEvent | TouchEvent) {
  return (e.shiftKey ? 4 : 0) + (e.altKey ? 8 : 0) + (e.ctrlKey ? 16 : 0);
}

function buttonCode(button: number) {
  if (button === 0) return 0; // left
  if (button === 1) return 1; // middle
  if (button === 2) return 2; // right
  return null;
}

function pressedButtonCode(buttons: number) {
  if (buttons & 1) return 0; // left
  if (buttons & 4) return 1; // middle
  if (buttons & 2) return 2; // right
  return null;
}

function mouseSeq(term: TerminalInstance, code: number, col: number, row: number, final: "M" | "m") {
  const mode = mouseTrackingMode(term);
  if (mode.sgr) return `\x1b[<${code};${col};${row}${final}`;
  if (col > 223 || row > 223) return "";
  const legacyCode = final === "m" ? 3 + eventModsShim(code) : code;
  return `\x1b[M${String.fromCharCode(32 + legacyCode)}${String.fromCharCode(32 + col)}${String.fromCharCode(32 + row)}`;
}

function eventModsShim(code: number) {
  return code & (4 | 8 | 16);
}

function consumeMouseEvent(e: Event) {
  e.preventDefault();
  e.stopPropagation();
  if ("stopImmediatePropagation" in e) e.stopImmediatePropagation();
}

function installMouseReporting(
  host: HTMLElement,
  term: TerminalInstance,
  sendRaw: (data: string) => void,
) {
  let lastButton = 0;

  const sendAt = (
    clientX: number,
    clientY: number,
    code: number,
    final: "M" | "m",
  ) => {
    const cell = mouseCell(term, clientX, clientY);
    if (!cell) return false;
    const seq = mouseSeq(term, code, cell.col, cell.row, final);
    if (!seq) return false;
    sendRaw(seq);
    return true;
  };

  const onMouseDown = (e: MouseEvent) => {
    const mode = mouseTrackingMode(term);
    if (!mode.enabled || !mode.button) return;
    const base = buttonCode(e.button);
    if (base == null) return;
    lastButton = base;
    if (sendAt(e.clientX, e.clientY, base + eventMods(e), "M")) consumeMouseEvent(e);
  };

  const onMouseMove = (e: MouseEvent) => {
    const mode = mouseTrackingMode(term);
    if (!mode.enabled || (!mode.drag && !mode.any)) return;
    const base = pressedButtonCode(e.buttons);
    if (base == null && !mode.any) return;
    const code = (base ?? 3) + 32 + eventMods(e);
    if (sendAt(e.clientX, e.clientY, code, "M")) consumeMouseEvent(e);
  };

  const onMouseUp = (e: MouseEvent) => {
    const mode = mouseTrackingMode(term);
    if (!mode.enabled || !mode.button) return;
    const base = buttonCode(e.button) ?? lastButton;
    if (sendAt(e.clientX, e.clientY, base + eventMods(e), "m")) consumeMouseEvent(e);
  };

  const onWheel = (e: WheelEvent) => {
    const mode = mouseTrackingMode(term);
    if (!mode.enabled || !mode.button || e.deltaY === 0) return;
    const cell = mouseCell(term, e.clientX, e.clientY);
    if (!cell) return;
    const dir = e.deltaY < 0 ? 64 : 65;
    const steps = Math.max(1, Math.min(5, Math.round(Math.abs(e.deltaY) / 33)));
    const seq = mouseSeq(term, dir + eventMods(e), cell.col, cell.row, "M");
    if (!seq) return;
    for (let i = 0; i < steps; i++) sendRaw(seq);
    consumeMouseEvent(e);
  };

  const onTouchStart = (e: TouchEvent) => {
    const mode = mouseTrackingMode(term);
    if (!mode.enabled || !mode.button) return;
    const t = e.changedTouches[0];
    if (!t) return;
    lastButton = 0;
    if (sendAt(t.clientX, t.clientY, eventMods(e), "M")) consumeMouseEvent(e);
  };

  const onTouchMove = (e: TouchEvent) => {
    const mode = mouseTrackingMode(term);
    if (!mode.enabled || !mode.drag) return;
    const t = e.changedTouches[0];
    if (!t) return;
    if (sendAt(t.clientX, t.clientY, 32 + eventMods(e), "M")) consumeMouseEvent(e);
  };

  const onTouchEnd = (e: TouchEvent) => {
    const mode = mouseTrackingMode(term);
    if (!mode.enabled || !mode.button) return;
    const t = e.changedTouches[0];
    if (!t) return;
    if (sendAt(t.clientX, t.clientY, lastButton + eventMods(e), "m")) consumeMouseEvent(e);
  };

  host.addEventListener("mousedown", onMouseDown, { capture: true });
  host.addEventListener("mousemove", onMouseMove, { capture: true });
  host.addEventListener("mouseup", onMouseUp, { capture: true });
  host.addEventListener("wheel", onWheel, { capture: true, passive: false });
  host.addEventListener("touchstart", onTouchStart, { capture: true, passive: false });
  host.addEventListener("touchmove", onTouchMove, { capture: true, passive: false });
  host.addEventListener("touchend", onTouchEnd, { capture: true, passive: false });
  host.addEventListener("touchcancel", onTouchEnd, { capture: true, passive: false });

  return () => {
    host.removeEventListener("mousedown", onMouseDown, true);
    host.removeEventListener("mousemove", onMouseMove, true);
    host.removeEventListener("mouseup", onMouseUp, true);
    host.removeEventListener("wheel", onWheel, true);
    host.removeEventListener("touchstart", onTouchStart, true);
    host.removeEventListener("touchmove", onTouchMove, true);
    host.removeEventListener("touchend", onTouchEnd, true);
    host.removeEventListener("touchcancel", onTouchEnd, true);
  };
}

export function TermView() {
  const [termSession, setTermSession] = useState(() => localStorage.getItem("lfg_term_session") || "main");
  const hostRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const termRef = useRef<InstanceType<typeof GhosttyTerminal> | null>(null);
  const [status, setStatus] = useState<"connecting" | "open" | "reconnecting" | "closed">("connecting");
  // URLs detected in the output stream → rendered as tappable chips, since a
  // wrapped URL is hard to tap inside the terminal grid (and reliable on iOS).
  const [links, setLinks] = useState<string[]>([]);
  // Long-press → Paste: ghostty's canvas input doesn't receive iOS's native
  // paste menu, so we surface our own. pasteAt = floating button position;
  // pasteInput = the native-input fallback when clipboard reads are blocked.
  const [pasteAt, setPasteAt] = useState<{ x: number; y: number } | null>(null);
  const [pasteInput, setPasteInput] = useState(false);
  const [keyboardActive, setKeyboardActive] = useState(false);
  const [copiedLink, setCopiedLink] = useState<string | null>(null);
  const lpTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lpStart = useRef<{ x: number; y: number } | null>(null);
  const pasteInputRef = useRef<HTMLInputElement>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keyboardActiveRef = useRef(false);
  const keyboardWasActiveAtPointerDownRef = useRef(false);

  useEffect(() => {
    const onSession = () => setTermSession(localStorage.getItem("lfg_term_session") || "main");
    window.addEventListener("lfg:term-session", onSession);
    return () => window.removeEventListener("lfg:term-session", onSession);
  }, []);

  const setTerminalKeyboardActive = useCallback((active: boolean) => {
    keyboardActiveRef.current = active;
    setKeyboardActive(active);
  }, []);

  // Send raw bytes (keystrokes / control sequences) to the PTY.
  const sendRaw = useCallback((data: string) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(new TextEncoder().encode(data));
  }, []);

  const cancelLongPress = useCallback(() => {
    if (lpTimer.current) {
      clearTimeout(lpTimer.current);
      lpTimer.current = null;
    }
  }, []);

  const onTouchStart = useCallback(
    (e: ReactTouchEvent) => {
      const t = e.touches[0];
      if (!t) return;
      lpStart.current = { x: t.clientX, y: t.clientY };
      cancelLongPress();
      lpTimer.current = setTimeout(
        () => setPasteAt({ x: t.clientX, y: t.clientY }),
        450,
      );
    },
    [cancelLongPress],
  );

  const onTouchMove = useCallback(
    (e: ReactTouchEvent) => {
      const t = e.touches[0];
      if (!t || !lpStart.current) return;
      if (Math.hypot(t.clientX - lpStart.current.x, t.clientY - lpStart.current.y) > 12)
        cancelLongPress();
    },
    [cancelLongPress],
  );

  // Read the clipboard and type it into the PTY (no trailing Enter — paste
  // semantics; the user reviews and hits ⏎). Falls back to a native input when
  // the browser blocks programmatic clipboard reads (common on iOS).
  const doPaste = useCallback(async () => {
    setPasteAt(null);
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        sendRaw(text);
        focusTerminalKeyboard(termRef.current);
        return;
      }
    } catch {
      /* fall through */
    }
    setPasteInput(true);
  }, [sendRaw]);

  const submitPasteInput = useCallback(() => {
    const v = pasteInputRef.current?.value ?? "";
    if (v) sendRaw(v);
    setPasteInput(false);
    focusTerminalKeyboard(termRef.current);
  }, [sendRaw]);

  const toggleKeyboard = useCallback((wasActive = keyboardActiveRef.current) => {
    if (wasActive) {
      blurTerminalKeyboard(termRef.current);
      setTerminalKeyboardActive(false);
    } else {
      focusTerminalKeyboard(termRef.current);
      setTerminalKeyboardActive(true);
    }
  }, [setTerminalKeyboardActive]);

  const copyLink = useCallback(async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      const input = document.createElement("textarea");
      input.value = url;
      input.setAttribute("readonly", "");
      input.style.position = "fixed";
      input.style.left = "-9999px";
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      input.remove();
    }
    setCopiedLink(url);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopiedLink(null), 1200);
  }, []);

  useEffect(() => {
    let disposed = false;
    let term: InstanceType<typeof GhosttyTerminal> | null = null;
    let fit: FitAddon | null = null;
    let ro: ResizeObserver | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let cleanupMouseReporting: (() => void) | null = null;
    let cleanupFocusTracking: (() => void) | null = null;
    let attempt = 0;

    // (Re)open the socket. The tmux shell session lives independently of serve,
    // so when serve restarts (deploys) the socket drops but the session is
    // intact — reconnecting just re-attaches and tmux repaints. That's what
    // makes a deploy non-destructive instead of wiping the terminal.
    const connect = () => {
      if (disposed || !term) return;
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${proto}//${location.host}/api/term?session=${encodeURIComponent(
        termSession,
      )}&cols=${term.cols}&rows=${term.rows}`;
      const ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onopen = () => {
        attempt = 0;
        setStatus("open");
        term?.focus();
        // Force tmux to repaint the reattached session at our geometry.
        if (term) ws.send(JSON.stringify({ t: "resize", cols: term.cols, rows: term.rows }));
      };
      ws.onmessage = (e) => {
        if (typeof e.data === "string") term?.write(e.data);
        else term?.write(new Uint8Array(e.data as ArrayBuffer));
      };
      ws.onclose = () => {
        wsRef.current = null;
        if (disposed) return;
        // Reconnect with backoff (0.5s → 5s) so a serve restart self-heals.
        setStatus("reconnecting");
        const delay = Math.min(5000, 500 * 2 ** attempt++);
        reconnectTimer = setTimeout(connect, delay);
      };
    };

    (async () => {
      await ensureGhostty();
      if (disposed || !hostRef.current) return;
      const isDark = document.documentElement.classList.contains("dark");
      term = new GhosttyTerminal({
        fontSize: 13,
        scrollback: 8000,
        cursorBlink: true,
        theme: isDark
          ? { background: "#0b0b0d", foreground: "#d4d4d8" }
          : { background: "#ffffff", foreground: "#18181b" },
      });
      fit = new FitAddon();
      term.loadAddon(fit);
      term.open(hostRef.current);
      cleanupMouseReporting = installMouseReporting(hostRef.current, term, sendRaw);
      const textarea = terminalInput(term);
      const onInputFocus = () => setTerminalKeyboardActive(true);
      const onInputBlur = () => setTerminalKeyboardActive(false);
      hostRef.current.addEventListener("focusin", onInputFocus);
      hostRef.current.addEventListener("focusout", onInputBlur);
      textarea?.addEventListener("focus", onInputFocus);
      textarea?.addEventListener("blur", onInputBlur);
      cleanupFocusTracking = () => {
        hostRef.current?.removeEventListener("focusin", onInputFocus);
        hostRef.current?.removeEventListener("focusout", onInputBlur);
        textarea?.removeEventListener("focus", onInputFocus);
        textarea?.removeEventListener("blur", onInputBlur);
      };
      try { fit.fit(); } catch {}
      termRef.current = term;

      // Keystrokes → binary frames; resizes → JSON control frames (the backend
      // distinguishes the two by frame type).
      term.onData((d: string) => {
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(new TextEncoder().encode(d));
      });
      term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify({ t: "resize", cols, rows }));
      });

      ro = new ResizeObserver(() => {
        try { fit?.fit(); } catch {}
      });
      ro.observe(hostRef.current);
      connect();
    })();

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try { cleanupMouseReporting?.(); } catch {}
      try { cleanupFocusTracking?.(); } catch {}
      try { ro?.disconnect(); } catch {}
      try { wsRef.current?.close(); } catch {}
      try { term?.dispose(); } catch {}
      termRef.current = null;
      wsRef.current = null;
    };
  }, [sendRaw]);

  // Detect links by polling tmux's logical buffer (wrapped lines rejoined), so
  // long URLs survive — the rendered stream breaks them at every wrap. Cheap
  // and only runs while the tab is mounted.
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const r = await fetch(`/api/term/scan?session=${encodeURIComponent(termSession)}`);
        const d = await r.json();
        if (alive && Array.isArray(d.urls) && d.urls.length)
          setLinks((prev) => mergeUrls(prev, d.urls));
      } catch {}
    };
    void poll();
    const iv = setInterval(poll, 2000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [termSession]);

  // Drop any pending long-press timer if the tab unmounts mid-press.
  useEffect(() => cancelLongPress, [cancelLongPress]);

  useEffect(() => {
    return () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    };
  }, []);

  // Lock pinch/double-tap/focus auto-zoom WHILE the terminal is mounted (iOS
  // zooms on a tap into the canvas's hidden input and on double-tap). We scope
  // it to this tab by patching the viewport meta and restoring it on unmount,
  // so the rest of the app keeps normal zoom.
  useEffect(() => {
    const meta = document.querySelector('meta[name="viewport"]');
    if (!meta) return;
    const prev = meta.getAttribute("content") ?? "";
    meta.setAttribute("content", prev + ", maximum-scale=1, user-scalable=no");
    return () => meta.setAttribute("content", prev);
  }, []);

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-2xl border border-border bg-[#0b0b0d]">
      <div className="flex items-center gap-2 border-b border-white/10 px-3 py-1.5 text-xs text-white/60">
        <TerminalSquare className="size-3.5" />
        <span className="font-medium">terminal · {termSession}</span>
        <span
          className={`ml-auto inline-flex items-center gap-1 ${
            status === "open"
              ? "text-emerald-400"
              : status === "closed"
                ? "text-destructive"
                : "text-white/50"
          }`}
        >
          <span className="size-1.5 rounded-full bg-current" />
          {status}
        </span>
      </div>
      <div
        ref={hostRef}
        onClick={() => focusTerminalKeyboard(termRef.current)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") focusTerminalKeyboard(termRef.current);
        }}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={cancelLongPress}
        onTouchCancel={cancelLongPress}
        onContextMenu={(e) => {
          e.preventDefault();
          setPasteAt({ x: e.clientX, y: e.clientY });
        }}
        style={{
          touchAction: "manipulation",
          WebkitTouchCallout: "none",
          userSelect: "none",
        }}
        role="button"
        tabIndex={0}
        aria-label="Focus terminal"
        className="min-h-0 flex-1 overflow-hidden p-1.5"
      />
      {/* Detected links — browser-native open/copy actions for verification
          URLs that a CLI tries to open inside the VM. */}
      {links.length > 0 ? (
        <div className="flex items-center gap-1.5 border-t border-white/10 px-2 py-1.5">
          <ExternalLink className="size-3.5 shrink-0 text-white/40" />
          <div className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto">
            {links.map((u) => (
              <div
                key={u}
                style={{ touchAction: "manipulation" }}
                className="flex max-w-[72vw] shrink-0 items-center overflow-hidden rounded-md bg-sky-500/20 text-xs font-medium text-sky-300"
              >
                <a
                  href={u}
                  target="_blank"
                  rel="noreferrer noopener"
                  title={u}
                  className="min-w-0 truncate px-2.5 py-1 active:bg-sky-500/40"
                >
                  {u.replace(/^https?:\/\//, "")}
                </a>
                <button
                  type="button"
                  onClick={() => void copyLink(u)}
                  title="Copy link"
                  aria-label="copy link"
                  className="grid size-7 shrink-0 place-items-center border-l border-sky-300/20 text-sky-200 active:bg-sky-500/40"
                >
                  {copiedLink === u ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setLinks([])}
            style={{ touchAction: "manipulation" }}
            className="shrink-0 rounded-md p-1 text-white/40 active:bg-white/10"
            aria-label="clear links"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ) : null}

      {/* On-screen control keys — a terminal is unusable on a phone without them. */}
      <div className="flex flex-wrap items-center gap-1 border-t border-white/10 px-2 py-1.5">
        {[
          ["esc", "Esc"],
          ["tab", "Tab"],
          ["ctrlC", "^C"],
          ["up", "↑"],
          ["down", "↓"],
          ["left", "←"],
          ["right", "→"],
          ["enter", "⏎"],
        ].map(([k, label]) => (
          <button
            type="button"
            key={k}
            onClick={() => sendRaw(KEYS[k as keyof typeof KEYS])}
            style={{ touchAction: "manipulation" }}
            className="rounded-md bg-white/10 px-2.5 py-1 text-xs font-medium text-white/80 active:bg-white/25"
          >
            {label}
          </button>
        ))}
        <button
          type="button"
          onPointerDown={() => {
            keyboardWasActiveAtPointerDownRef.current = keyboardActiveRef.current;
          }}
          onClick={(e) =>
            toggleKeyboard(
              e.detail === 0
                ? keyboardActiveRef.current
                : keyboardWasActiveAtPointerDownRef.current,
            )
          }
          style={{ touchAction: "manipulation" }}
          aria-pressed={keyboardActive}
          aria-label={keyboardActive ? "hide keyboard" : "show keyboard"}
          title={keyboardActive ? "Hide keyboard" : "Show keyboard"}
          className={`ml-auto flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium active:bg-white/25 ${
            keyboardActive ? "bg-white text-black" : "bg-white/10 text-white/80"
          }`}
        >
          {keyboardActive ? <KeyboardOff className="size-3.5" /> : <Keyboard className="size-3.5" />}
          Keyboard
        </button>
        <button
          type="button"
          onClick={doPaste}
          style={{ touchAction: "manipulation" }}
          className="flex items-center gap-1 rounded-md bg-white/10 px-2.5 py-1 text-xs font-medium text-white/80 active:bg-white/25"
        >
          <ClipboardPaste className="size-3.5" />
          Paste
        </button>
      </div>

      {/* Long-press / right-click → floating Paste button at the touch point. */}
      {pasteAt ? (
        <>
          <button
            type="button"
            className="fixed inset-0 z-40"
            onClick={() => setPasteAt(null)}
            aria-label="Dismiss paste menu"
          />
          <button
            type="button"
            onClick={doPaste}
            style={{
              position: "fixed",
              left: Math.max(8, Math.min(pasteAt.x - 40, window.innerWidth - 110)),
              top: Math.max(8, pasteAt.y - 48),
              touchAction: "manipulation",
            }}
            className="z-50 flex items-center gap-1.5 rounded-xl bg-white px-4 py-2.5 text-sm font-semibold text-black shadow-xl active:scale-95"
          >
            <ClipboardPaste className="size-4" />
            Paste
          </button>
        </>
      ) : null}

      {/* Fallback when the browser blocks clipboard reads: a real input the user
          can long-press → Paste into (always works on iOS), then send. */}
      {pasteInput ? (
        <div className="fixed inset-x-0 bottom-0 z-50 flex items-center gap-2 border-t border-white/10 bg-[#0b0b0d] p-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))]">
          <input
            ref={pasteInputRef}
            autoFocus
            aria-label="Paste terminal input"
            placeholder="Long-press here → Paste, then Send"
            onKeyDown={(e) => {
              if (e.key === "Enter") submitPasteInput();
            }}
            style={{ fontSize: 16 }}
            className="min-w-0 flex-1 rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-white placeholder:text-white/30"
          />
          <button
            type="button"
            onClick={submitPasteInput}
            className="rounded-lg bg-white px-3 py-2 text-sm font-semibold text-black active:scale-95"
          >
            Send
          </button>
          <button
            type="button"
            onClick={() => setPasteInput(false)}
            className="rounded-lg p-2 text-white/50 active:bg-white/10"
            aria-label="cancel paste"
          >
            <X className="size-4" />
          </button>
        </div>
      ) : null}
    </div>
  );
}
