// The Terminal tab: a faithful browser terminal — ghostty-web (Ghostty's real
// VT engine compiled to WASM) bridged over a websocket to a persistent tmux
// shell on the box. ghostty-web renders Claude Code's heavy TUI faithfully where
// xterm.js mangles it, which is the case we mostly care about here.
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, TouchEvent as ReactTouchEvent } from "react";
import { init, Terminal as GhosttyTerminal, FitAddon } from "ghostty-web";
import {
  Check,
  ClipboardPaste,
  Copy,
  ExternalLink,
  Keyboard,
  KeyboardOff,
  SendHorizontal,
  TerminalSquare,
  X,
} from "lucide-react";

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
const KEY_SEQUENCES = {
  esc: "\x1b",
  tab: "\t",
  ctrlC: "\x03",
  ctrlD: "\x04",
  ctrlA: "\x01",
  ctrlE: "\x05",
  ctrlL: "\x0c",
  ctrlN: "\x0e",
  ctrlP: "\x10",
  up: "\x1b[A",
  down: "\x1b[B",
  left: "\x1b[D",
  right: "\x1b[C",
  enter: "\r",
  backspace: "\x7f",
  delete: "\x1b[3~",
  home: "\x1b[H",
  end: "\x1b[F",
  pageUp: "\x1b[5~",
  pageDown: "\x1b[6~",
} as const;

type HelperKey = {
  id: string;
  label: string;
  sequence: string;
  ariaLabel: string;
  title?: string;
};

const HELPER_KEY_GROUPS: Array<{ id: string; label: string; keys: HelperKey[] }> = [
  {
    id: "command",
    label: "Cmd",
    keys: [
      { id: "esc", label: "Esc", sequence: KEY_SEQUENCES.esc, ariaLabel: "Escape" },
      { id: "tab", label: "Tab", sequence: KEY_SEQUENCES.tab, ariaLabel: "Tab" },
      { id: "ctrlC", label: "^C", sequence: KEY_SEQUENCES.ctrlC, ariaLabel: "Control C" },
      { id: "ctrlD", label: "^D", sequence: KEY_SEQUENCES.ctrlD, ariaLabel: "Control D" },
      { id: "ctrlL", label: "^L", sequence: KEY_SEQUENCES.ctrlL, ariaLabel: "Control L" },
    ],
  },
  {
    id: "history",
    label: "Hist",
    keys: [
      { id: "ctrlP", label: "^P", sequence: KEY_SEQUENCES.ctrlP, ariaLabel: "Control P" },
      { id: "ctrlN", label: "^N", sequence: KEY_SEQUENCES.ctrlN, ariaLabel: "Control N" },
      { id: "up", label: "↑", sequence: KEY_SEQUENCES.up, ariaLabel: "Arrow up" },
      { id: "down", label: "↓", sequence: KEY_SEQUENCES.down, ariaLabel: "Arrow down" },
    ],
  },
  {
    id: "move",
    label: "Move",
    keys: [
      { id: "left", label: "←", sequence: KEY_SEQUENCES.left, ariaLabel: "Arrow left" },
      { id: "right", label: "→", sequence: KEY_SEQUENCES.right, ariaLabel: "Arrow right" },
      { id: "ctrlA", label: "^A", sequence: KEY_SEQUENCES.ctrlA, ariaLabel: "Control A" },
      { id: "ctrlE", label: "^E", sequence: KEY_SEQUENCES.ctrlE, ariaLabel: "Control E" },
      { id: "enter", label: "⏎", sequence: KEY_SEQUENCES.enter, ariaLabel: "Enter" },
    ],
  },
];

const SPECIAL_KEY_SEQUENCES: Record<string, string> = {
  esc: KEY_SEQUENCES.esc,
  escape: KEY_SEQUENCES.esc,
  tab: KEY_SEQUENCES.tab,
  enter: KEY_SEQUENCES.enter,
  return: KEY_SEQUENCES.enter,
  ret: KEY_SEQUENCES.enter,
  up: KEY_SEQUENCES.up,
  down: KEY_SEQUENCES.down,
  left: KEY_SEQUENCES.left,
  right: KEY_SEQUENCES.right,
  arrowup: KEY_SEQUENCES.up,
  arrowdown: KEY_SEQUENCES.down,
  arrowleft: KEY_SEQUENCES.left,
  arrowright: KEY_SEQUENCES.right,
  backspace: KEY_SEQUENCES.backspace,
  bs: KEY_SEQUENCES.backspace,
  del: KEY_SEQUENCES.delete,
  delete: KEY_SEQUENCES.delete,
  home: KEY_SEQUENCES.home,
  end: KEY_SEQUENCES.end,
  pgup: KEY_SEQUENCES.pageUp,
  pageup: KEY_SEQUENCES.pageUp,
  "page-up": KEY_SEQUENCES.pageUp,
  pgdn: KEY_SEQUENCES.pageDown,
  pagedown: KEY_SEQUENCES.pageDown,
  "page-down": KEY_SEQUENCES.pageDown,
  space: " ",
};

const FUNCTION_KEY_SEQUENCES: Record<string, string> = {
  f1: "\x1bOP",
  f2: "\x1bOQ",
  f3: "\x1bOR",
  f4: "\x1bOS",
  f5: "\x1b[15~",
  f6: "\x1b[17~",
  f7: "\x1b[18~",
  f8: "\x1b[19~",
  f9: "\x1b[20~",
  f10: "\x1b[21~",
  f11: "\x1b[23~",
  f12: "\x1b[24~",
};

const KEY_ALIASES: Record<string, string> = {
  "↑": "up",
  "↓": "down",
  "←": "left",
  "→": "right",
  arrowup: "up",
  arrowdown: "down",
  arrowleft: "left",
  arrowright: "right",
  escape: "esc",
  return: "enter",
  ret: "enter",
  "page-up": "pageup",
  "page-down": "pagedown",
};

function canonicalKeyName(key: string) {
  return KEY_ALIASES[key] ?? key;
}

function controlKeySequence(key: string) {
  const k = canonicalKeyName(key);
  if (/^[a-z]$/.test(k)) return String.fromCharCode(k.toUpperCase().charCodeAt(0) - 64);
  if (k === "space" || k === "@") return "\x00";
  if (k === "[" || k === "esc") return "\x1b";
  if (k === "\\") return "\x1c";
  if (k === "]") return "\x1d";
  if (k === "^") return "\x1e";
  if (k === "_") return "\x1f";
  if (k === "?") return "\x7f";
  return null;
}

function modifiedSpecialKeySequence(key: string, mods: { alt: boolean; ctrl: boolean }) {
  if (!mods.alt && !mods.ctrl) return null;
  const k = canonicalKeyName(key);
  const modifier = 1 + (mods.alt ? 2 : 0) + (mods.ctrl ? 4 : 0);
  if (k === "up") return `\x1b[1;${modifier}A`;
  if (k === "down") return `\x1b[1;${modifier}B`;
  if (k === "right") return `\x1b[1;${modifier}C`;
  if (k === "left") return `\x1b[1;${modifier}D`;
  if (k === "home") return `\x1b[1;${modifier}H`;
  if (k === "end") return `\x1b[1;${modifier}F`;
  return null;
}

function plainKeySequence(key: string) {
  const k = canonicalKeyName(key);
  if (k.length === 1) return k;
  return SPECIAL_KEY_SEQUENCES[k] ?? FUNCTION_KEY_SEQUENCES[k] ?? null;
}

function parseTerminalKey(input: string) {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const normalized = trimmed
    .replace(/[＋]/g, "+")
    .replace(/\s*\+\s*/g, "+")
    .replace(/\s+/g, "+")
    .toLowerCase();

  if (normalized.startsWith("^") && normalized.length > 1) {
    return controlKeySequence(normalized.slice(1));
  }

  const parts = normalized.split("+").filter(Boolean);
  let alt = false;
  let ctrl = false;
  const keyParts: string[] = [];
  for (const part of parts) {
    if (part === "alt" || part === "option" || part === "opt") {
      alt = true;
    } else if (part === "ctrl" || part === "control" || part === "ctl") {
      ctrl = true;
    } else {
      keyParts.push(part);
    }
  }

  const key = keyParts.join("+");
  if (!key) return null;
  const modified = modifiedSpecialKeySequence(key, { alt, ctrl });
  if (modified) return modified;

  const sequence = ctrl ? controlKeySequence(key) : plainKeySequence(key);
  if (sequence == null) return null;
  return alt ? `\x1b${sequence}` : sequence;
}

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
  const [customKey, setCustomKey] = useState("");
  const [customKeyInvalid, setCustomKeyInvalid] = useState(false);
  const lpTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lpStart = useRef<{ x: number; y: number } | null>(null);
  const pasteInputRef = useRef<HTMLInputElement>(null);
  const customKeyInputRef = useRef<HTMLInputElement>(null);
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

  const submitCustomKey = useCallback((e?: FormEvent<HTMLFormElement>) => {
    e?.preventDefault();
    const sequence = parseTerminalKey(customKey);
    if (sequence == null) {
      setCustomKeyInvalid(true);
      customKeyInputRef.current?.focus();
      return;
    }
    sendRaw(sequence);
    setCustomKey("");
    setCustomKeyInvalid(false);
    focusTerminalKeyboard(termRef.current);
  }, [customKey, sendRaw]);

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
      <div className="grid gap-2 border-t border-white/10 bg-[#0b0b0d] px-2 py-2">
        <div className="flex gap-2 overflow-x-auto pb-0.5">
          {HELPER_KEY_GROUPS.map((group) => (
            <div key={group.id} className="flex shrink-0 items-center gap-1">
              <span className="px-1 text-[10px] font-semibold uppercase text-white/35">
                {group.label}
              </span>
              {group.keys.map((key) => (
                <button
                  type="button"
                  key={key.id}
                  onClick={() => sendRaw(key.sequence)}
                  style={{ touchAction: "manipulation" }}
                  aria-label={key.ariaLabel}
                  title={key.title ?? key.ariaLabel}
                  className="grid h-8 min-w-8 place-items-center rounded-md bg-white/10 px-2 text-xs font-semibold text-white/85 active:bg-white/25"
                >
                  {key.label}
                </button>
              ))}
            </div>
          ))}
        </div>
        <div className="flex min-w-0 items-center gap-1.5">
          <form
            onSubmit={submitCustomKey}
            className={`flex min-w-0 flex-1 items-center gap-1 rounded-lg border px-2 py-1 ${
              customKeyInvalid
                ? "border-red-400/70 bg-red-500/10"
                : "border-white/10 bg-white/[0.04]"
            }`}
          >
            <span className="shrink-0 text-[10px] font-semibold uppercase text-white/35">Key</span>
            <input
              ref={customKeyInputRef}
              value={customKey}
              onChange={(e) => {
                setCustomKey(e.target.value);
                setCustomKeyInvalid(false);
              }}
              placeholder="ctrl+p"
              inputMode="text"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              aria-label="Custom terminal key"
              aria-invalid={customKeyInvalid}
              style={{ fontSize: 16 }}
              className="min-w-0 flex-1 bg-transparent px-1 py-1 text-sm text-white outline-none placeholder:text-white/25"
            />
            <button
              type="submit"
              style={{ touchAction: "manipulation" }}
              className="grid size-7 shrink-0 place-items-center rounded-md bg-white/10 text-white/85 active:bg-white/25"
              aria-label="Send custom terminal key"
              title="Send custom terminal key"
            >
              <SendHorizontal className="size-3.5" />
            </button>
          </form>
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
            className={`flex h-9 shrink-0 items-center gap-1 rounded-lg px-2.5 text-xs font-medium active:bg-white/25 ${
              keyboardActive ? "bg-white text-black" : "bg-white/10 text-white/80"
            }`}
          >
            {keyboardActive ? <KeyboardOff className="size-3.5" /> : <Keyboard className="size-3.5" />}
            <span className="hidden sm:inline">Keyboard</span>
          </button>
          <button
            type="button"
            onClick={doPaste}
            style={{ touchAction: "manipulation" }}
            aria-label="Paste terminal input"
            title="Paste terminal input"
            className="flex h-9 shrink-0 items-center gap-1 rounded-lg bg-white/10 px-2.5 text-xs font-medium text-white/80 active:bg-white/25"
          >
            <ClipboardPaste className="size-3.5" />
            <span className="hidden sm:inline">Paste</span>
          </button>
        </div>
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
