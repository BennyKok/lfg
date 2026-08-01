// The Terminal tab: a faithful browser terminal — ghostty-web (Ghostty's real
// VT engine compiled to WASM) bridged over a websocket to a persistent tmux
// shell on the box. ghostty-web renders Claude Code's heavy TUI faithfully where
// xterm.js mangles it, which is the case we mostly care about here.
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, TouchEvent as ReactTouchEvent } from "react";
import { init, Terminal as GhosttyTerminal, FitAddon } from "ghostty-web";
import {
  Check,
  ChevronRight,
  ClipboardPaste,
  Copy,
  ExternalLink,
  Keyboard,
  Pin,
  PinOff,
  RotateCcw,
  SendHorizontal,
  TerminalSquare,
  X,
} from "lucide-react";
import { lfgFetch } from "@/lib/lfg-client";

// One WASM load per page, shared across mount/unmount of the tab.
let ghosttyReady: Promise<void> | null = null;
const ensureGhostty = () => (ghosttyReady ??= init());

// The terminal is a self-contained dark surface (header, link tray, and key
// controls all use this palette), regardless of the surrounding app theme.
// Keeping Ghostty dark too also preserves the contrast of its default ANSI
// palette, which is designed for a dark background.
const TERMINAL_THEME = {
  background: "#0b0b0d",
  foreground: "#d4d4d8",
  cursor: "#fafafa",
  cursorAccent: "#0b0b0d",
  selectionBackground: "#3f3f46",
  selectionForeground: "#fafafa",
} as const;

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

type DeckKey = {
  id: string;
  /** Single-character hint: press it while the deck is open to fire the key. */
  hint: string;
  label: string;
  desc: string;
  sequence: string;
  ariaLabel: string;
};

// The vi menu's key map. Every entry is both a tap target and a one-letter hint
// you can type while the deck is open. Hints follow vi wherever vi has an
// opinion (hjkl motion, 0/$ line ends, g/G, u/f paging, x delete) so existing
// muscle memory transfers instead of having to be learned. Case matters — `l`
// is right-arrow, `L` is ^L — which is also how vi treats g/G.
const DECK_SECTIONS: Array<{ id: string; label: string; keys: DeckKey[] }> = [
  {
    id: "move",
    label: "Move",
    keys: [
      { id: "left", hint: "h", label: "←", desc: "left", sequence: KEY_SEQUENCES.left, ariaLabel: "Arrow left" },
      { id: "down", hint: "j", label: "↓", desc: "down", sequence: KEY_SEQUENCES.down, ariaLabel: "Arrow down" },
      { id: "up", hint: "k", label: "↑", desc: "up", sequence: KEY_SEQUENCES.up, ariaLabel: "Arrow up" },
      { id: "right", hint: "l", label: "→", desc: "right", sequence: KEY_SEQUENCES.right, ariaLabel: "Arrow right" },
      { id: "bol", hint: "0", label: "^A", desc: "line start", sequence: KEY_SEQUENCES.ctrlA, ariaLabel: "Control A" },
      { id: "eol", hint: "$", label: "^E", desc: "line end", sequence: KEY_SEQUENCES.ctrlE, ariaLabel: "Control E" },
      { id: "home", hint: "g", label: "Home", desc: "top", sequence: KEY_SEQUENCES.home, ariaLabel: "Home" },
      { id: "end", hint: "G", label: "End", desc: "bottom", sequence: KEY_SEQUENCES.end, ariaLabel: "End" },
      { id: "pgup", hint: "u", label: "PgUp", desc: "page up", sequence: KEY_SEQUENCES.pageUp, ariaLabel: "Page up" },
      { id: "pgdn", hint: "f", label: "PgDn", desc: "page down", sequence: KEY_SEQUENCES.pageDown, ariaLabel: "Page down" },
    ],
  },
  {
    id: "signal",
    label: "Signal",
    keys: [
      { id: "esc", hint: "e", label: "Esc", desc: "escape", sequence: KEY_SEQUENCES.esc, ariaLabel: "Escape" },
      { id: "ctrlC", hint: "c", label: "^C", desc: "interrupt", sequence: KEY_SEQUENCES.ctrlC, ariaLabel: "Control C" },
      { id: "ctrlD", hint: "d", label: "^D", desc: "eof", sequence: KEY_SEQUENCES.ctrlD, ariaLabel: "Control D" },
      { id: "ctrlL", hint: "L", label: "^L", desc: "clear", sequence: KEY_SEQUENCES.ctrlL, ariaLabel: "Control L" },
    ],
  },
  {
    id: "history",
    label: "History",
    keys: [
      { id: "ctrlP", hint: "p", label: "^P", desc: "previous", sequence: KEY_SEQUENCES.ctrlP, ariaLabel: "Control P" },
      { id: "ctrlN", hint: "n", label: "^N", desc: "next", sequence: KEY_SEQUENCES.ctrlN, ariaLabel: "Control N" },
    ],
  },
  {
    id: "edit",
    label: "Edit",
    keys: [
      { id: "tab", hint: "t", label: "Tab", desc: "complete", sequence: KEY_SEQUENCES.tab, ariaLabel: "Tab" },
      { id: "enter", hint: "r", label: "⏎", desc: "return", sequence: KEY_SEQUENCES.enter, ariaLabel: "Enter" },
      { id: "backspace", hint: "b", label: "⌫", desc: "backspace", sequence: KEY_SEQUENCES.backspace, ariaLabel: "Backspace" },
      { id: "delete", hint: "x", label: "Del", desc: "delete", sequence: KEY_SEQUENCES.delete, ariaLabel: "Delete" },
    ],
  },
];

const DECK_KEY_BY_HINT = new Map(
  DECK_SECTIONS.flatMap((s) => s.keys.map((k) => [k.hint, k] as const)),
);

// Deck-level commands. Their hints are chosen to not collide with any key hint
// above: i = "insert mode" (hand focus back to the shell), P = put/paste,
// . = repeat last key, : = type any key spec, s = stick the deck open.
const DECK_ACTION_HINTS = { insert: "i", paste: "P", repeat: ".", command: ":", stick: "s" } as const;

const DECK_STICKY_KEY = "lfg_term_deck_sticky";

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

// Ghostty's hidden input is a plain <textarea>, so mobile keyboards apply their
// prose defaults to it: capitalise the first letter of a "sentence", autocorrect
// words, offer predictions. In a shell that's actively wrong — `Git status`,
// `Ls`, and a "corrected" flag are all just errors. Type lowercase and let Shift
// mean Shift, the way a keyboard behaves in a terminal app.
function tameTerminalInput(term: TerminalInstance | null) {
  const input = terminalInput(term);
  if (!input) return;
  input.setAttribute("autocapitalize", "none");
  input.setAttribute("autocorrect", "off");
  input.setAttribute("autocomplete", "off");
  input.setAttribute("spellcheck", "false");
  // The property assignment matters too: WebKit reads the IDL attribute, and it
  // does not always reflect a late setAttribute on an already-focused field.
  try {
    (input as HTMLTextAreaElement).autocapitalize = "none";
    (input as HTMLTextAreaElement).spellcheck = false;
  } catch {}
}

function focusTerminalKeyboard(term: TerminalInstance | null) {
  if (!term) return;
  term.focus();
  // Re-assert on every focus: ghostty recreates/reconfigures the input, and the
  // casing hint has to be in place *before* the keyboard comes up to take.
  tameTerminalInput(term);
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

function DeckAction({
  hint,
  label,
  icon: Icon,
  onClick,
  disabled,
  active,
}: {
  hint: string;
  label: string;
  icon: typeof Keyboard;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{ touchAction: "manipulation" }}
      title={`${label} — press ${hint}`}
      aria-label={label}
      className={`flex h-9 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-lg px-2 text-xs font-medium disabled:opacity-30 ${
        active ? "bg-white text-black" : "bg-white/[0.07] text-white/80 active:bg-white/25"
      }`}
    >
      <Icon className="size-3.5 shrink-0" />
      <span className="truncate">{label}</span>
      <span
        className={`font-mono text-[9px] leading-none ${active ? "text-black/45" : "text-white/35"}`}
      >
        {hint}
      </span>
    </button>
  );
}

type DeckMode = "normal" | "command";

/**
 * The vi menu — every extra terminal key, hidden until summoned.
 *
 * The old chrome kept ~110px of key toolbar on screen permanently for keys you
 * touch a few times a minute. This trades that for a modal deck: the terminal
 * is full-bleed by default, and ⌃⇧K / the Keys button / a swipe up from the
 * bottom edge brings the keys in.
 *
 * While it's open the deck OWNS the keyboard (capture-phase listener, so
 * ghostty's textarea never sees the keystroke) and every key is a one-letter
 * hint — the same thing you'd tap on a phone. `:` drops into command mode for
 * anything not on the grid, `.` repeats, `i` hands focus back to the shell.
 */
function KeyDeck({
  open,
  sticky,
  lastKey,
  onSendKey,
  onSendSequence,
  onPaste,
  onInsert,
  onToggleSticky,
  onClose,
}: {
  open: boolean;
  sticky: boolean;
  lastKey: DeckKey | null;
  onSendKey: (key: DeckKey) => void;
  onSendSequence: (sequence: string) => void;
  onPaste: () => void;
  onInsert: () => void;
  onToggleSticky: () => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<DeckMode>("normal");
  const [command, setCommand] = useState("");
  const [invalid, setInvalid] = useState(false);
  const commandRef = useRef<HTMLInputElement>(null);

  // Every summon starts in normal mode — the deck is never left half-open in
  // command mode from a previous visit.
  useEffect(() => {
    if (!open) {
      setMode("normal");
      setCommand("");
      setInvalid(false);
    }
  }, [open]);

  useEffect(() => {
    if (open && mode === "command") commandRef.current?.focus();
  }, [open, mode]);

  const submitCommand = useCallback(
    (e?: FormEvent<HTMLFormElement>) => {
      e?.preventDefault();
      const sequence = parseTerminalKey(command);
      if (sequence == null) {
        setInvalid(true);
        commandRef.current?.focus();
        return;
      }
      onSendSequence(sequence);
      setCommand("");
      setInvalid(false);
    },
    [command, onSendSequence],
  );

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (mode === "command") setMode("normal");
        else onClose();
        return;
      }
      // In command mode the input owns the keyboard — hints would fight typing.
      if (mode === "command") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const hit = DECK_KEY_BY_HINT.get(e.key);
      const consume = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      if (hit) {
        consume();
        onSendKey(hit);
        return;
      }
      switch (e.key) {
        case DECK_ACTION_HINTS.insert:
          consume();
          onInsert();
          return;
        case DECK_ACTION_HINTS.paste:
          consume();
          onPaste();
          return;
        case DECK_ACTION_HINTS.repeat:
          consume();
          if (lastKey) onSendKey(lastKey);
          return;
        case DECK_ACTION_HINTS.command:
          consume();
          setMode("command");
          return;
        case DECK_ACTION_HINTS.stick:
          consume();
          onToggleSticky();
          return;
        case "q": // vi's "quit this menu"
          consume();
          onClose();
          return;
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open, mode, lastKey, onClose, onInsert, onPaste, onSendKey, onToggleSticky]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-label="Terminal keys"
      className="lfg-term-deck absolute inset-x-0 bottom-0 z-30 border-t border-white/10 bg-[#0b0b0d]/97 backdrop-blur-md"
    >
      <div className="flex items-center gap-2 px-2.5 pb-1 pt-2">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-white/35">Keys</span>
        <span className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[10px] text-white/60">
          {mode === "command" ? ":" : "normal"}
        </span>
        <span className="hidden truncate text-[10px] text-white/30 sm:inline">
          press a hint · {DECK_ACTION_HINTS.command} any key · q close
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={onToggleSticky}
            style={{ touchAction: "manipulation" }}
            aria-pressed={sticky}
            title={sticky ? "Unstick — close after each key (s)" : "Stick open — stay open after a key (s)"}
            aria-label={sticky ? "Unstick key deck" : "Stick key deck open"}
            className={`grid size-7 place-items-center rounded-md ${
              sticky ? "bg-white text-black" : "bg-white/10 text-white/60 active:bg-white/25"
            }`}
          >
            {sticky ? <Pin className="size-3.5" /> : <PinOff className="size-3.5" />}
          </button>
          <button
            type="button"
            onClick={onClose}
            style={{ touchAction: "manipulation" }}
            title="Close keys (Esc)"
            aria-label="Close terminal keys"
            className="grid size-7 place-items-center rounded-md bg-white/10 text-white/60 active:bg-white/25"
          >
            <X className="size-3.5" />
          </button>
        </div>
      </div>

      <div className="max-h-[42vh] overflow-y-auto px-2.5 pb-1.5">
        {DECK_SECTIONS.map((section) => (
          <div key={section.id} className="mb-2 last:mb-0">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-white/25">
              {section.label}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {section.keys.map((key) => (
                <button
                  type="button"
                  key={key.id}
                  onClick={() => onSendKey(key)}
                  style={{ touchAction: "manipulation" }}
                  aria-label={key.ariaLabel}
                  title={`${key.desc} — press ${key.hint}`}
                  className="relative grid h-11 min-w-14 place-items-center rounded-lg bg-white/[0.07] px-2.5 text-sm font-semibold text-white/85 active:bg-white/25"
                >
                  <span>{key.label}</span>
                  <span className="absolute right-1 top-0.5 font-mono text-[9px] leading-none text-white/35">
                    {key.hint}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-1.5 border-t border-white/[0.07] px-2.5 py-2 pb-[calc(0.5rem+var(--lfg-safe-bottom,0px))]">
        {mode === "command" ? (
          <form
            onSubmit={submitCommand}
            className={`flex min-w-0 flex-1 items-center gap-1 rounded-lg border px-2 py-1 ${
              invalid ? "border-red-400/70 bg-red-500/10" : "border-white/10 bg-white/[0.04]"
            }`}
          >
            <span className="shrink-0 font-mono text-sm text-white/40">:</span>
            <input
              ref={commandRef}
              value={command}
              onChange={(e) => {
                setCommand(e.target.value);
                setInvalid(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  setMode("normal");
                }
              }}
              placeholder="ctrl+p · f5 · alt+."
              inputMode="text"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              aria-label="Terminal key to send"
              aria-invalid={invalid}
              style={{ fontSize: 16 }}
              className="min-w-0 flex-1 bg-transparent px-1 py-1 text-sm text-white outline-none placeholder:text-white/25"
            />
            <button
              type="submit"
              style={{ touchAction: "manipulation" }}
              className="grid size-7 shrink-0 place-items-center rounded-md bg-white/10 text-white/85 active:bg-white/25"
              aria-label="Send terminal key"
              title="Send terminal key"
            >
              <SendHorizontal className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setMode("normal")}
              style={{ touchAction: "manipulation" }}
              className="grid size-7 shrink-0 place-items-center rounded-md text-white/45 active:bg-white/15"
              aria-label="Leave command mode"
              title="Leave command mode (Esc)"
            >
              <X className="size-3.5" />
            </button>
          </form>
        ) : (
          <>
            <DeckAction
              hint={DECK_ACTION_HINTS.insert}
              label="Insert"
              icon={Keyboard}
              onClick={onInsert}
            />
            <DeckAction
              hint={DECK_ACTION_HINTS.paste}
              label="Paste"
              icon={ClipboardPaste}
              onClick={onPaste}
            />
            <DeckAction
              hint={DECK_ACTION_HINTS.repeat}
              label={lastKey ? `Again ${lastKey.label}` : "Again"}
              icon={RotateCcw}
              disabled={!lastKey}
              onClick={() => lastKey && onSendKey(lastKey)}
            />
            <DeckAction
              hint={DECK_ACTION_HINTS.command}
              label="Key…"
              icon={ChevronRight}
              onClick={() => setMode("command")}
            />
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Props let the same terminal serve two roles: the global Terminal tab (no
 * props — a free-form shell named by localStorage), and a session's own
 * terminal (`sessionId`), which attaches to a dedicated persistent tmux session
 * whose shell starts in that session's worktree.
 */
export function TermView({
  sessionId,
  label,
  onClose,
}: {
  sessionId?: string;
  label?: string;
  onClose?: () => void;
} = {}) {
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
  // The vi menu. Closed by default — that's the whole point of the redesign.
  const [deckOpen, setDeckOpen] = useState(false);
  const [deckSticky, setDeckSticky] = useState(
    () => localStorage.getItem(DECK_STICKY_KEY) === "1",
  );
  const [lastKey, setLastKey] = useState<DeckKey | null>(null);
  const lpTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lpStart = useRef<{ x: number; y: number } | null>(null);
  const lpFromBottomEdge = useRef(false);
  const pasteInputRef = useRef<HTMLInputElement>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keyboardActiveRef = useRef(false);
  const deckOpenRef = useRef(false);
  // Whether the shell had keyboard focus when the deck was summoned, so closing
  // the deck puts you back exactly where you were instead of typing into a void.
  const resumeFocusRef = useRef(false);

  // Which shell this view is attached to. A session terminal is keyed by the
  // session id (server-side it resolves to that session's worktree); the global
  // Terminal tab keeps its free-form localStorage-named shell.
  const connTarget = sessionId
    ? `sessionId=${encodeURIComponent(sessionId)}`
    : `session=${encodeURIComponent(termSession)}`;

  useEffect(() => {
    if (sessionId) return;
    const onSession = () => setTermSession(localStorage.getItem("lfg_term_session") || "main");
    window.addEventListener("lfg:term-session", onSession);
    return () => window.removeEventListener("lfg:term-session", onSession);
  }, [sessionId]);

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

  const openDeck = useCallback(() => {
    if (deckOpenRef.current) return;
    deckOpenRef.current = true;
    // Remember whether we were "in insert mode" so closing restores it, and drop
    // shell focus while the menu is up (on a phone that also gets the software
    // keyboard out of the way, which is most of the screen).
    resumeFocusRef.current = keyboardActiveRef.current;
    blurTerminalKeyboard(termRef.current);
    setTerminalKeyboardActive(false);
    setDeckOpen(true);
  }, [setTerminalKeyboardActive]);

  const onTouchStart = useCallback(
    (e: ReactTouchEvent) => {
      const t = e.touches[0];
      if (!t) return;
      lpStart.current = { x: t.clientX, y: t.clientY };
      // A touch that starts within the bottom strip of the terminal arms the
      // swipe-up gesture that summons the key deck — the same grab-from-the-edge
      // affordance as the handle it sits behind.
      const rect = hostRef.current?.getBoundingClientRect();
      lpFromBottomEdge.current = !!rect && t.clientY >= rect.bottom - 36;
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
      const dy = lpStart.current.y - t.clientY;
      if (lpFromBottomEdge.current && dy > 28 && Math.abs(t.clientX - lpStart.current.x) < 48) {
        lpFromBottomEdge.current = false;
        lpStart.current = null;
        cancelLongPress();
        openDeck();
        return;
      }
      if (Math.hypot(t.clientX - lpStart.current.x, t.clientY - lpStart.current.y) > 12)
        cancelLongPress();
    },
    [cancelLongPress, openDeck],
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

  // ---- vi menu plumbing (openDeck lives above, the touch handlers need it) ----

  const closeDeck = useCallback(() => {
    deckOpenRef.current = false;
    setDeckOpen(false);
    if (resumeFocusRef.current) {
      focusTerminalKeyboard(termRef.current);
      setTerminalKeyboardActive(true);
    }
  }, [setTerminalKeyboardActive]);

  const enterInsertMode = useCallback(() => {
    resumeFocusRef.current = true;
    deckOpenRef.current = false;
    setDeckOpen(false);
    focusTerminalKeyboard(termRef.current);
    setTerminalKeyboardActive(true);
  }, [setTerminalKeyboardActive]);

  const toggleDeckSticky = useCallback(() => {
    setDeckSticky((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(DECK_STICKY_KEY, next ? "1" : "0");
      } catch {}
      return next;
    });
  }, []);

  // A key fired from the deck closes it again unless it's stuck open — the
  // common case is one key (^C, Tab, ↑) and straight back to a full-height
  // terminal. Stick it when you're arrowing through history.
  const afterDeckAction = useCallback(() => {
    if (!deckSticky) closeDeck();
  }, [deckSticky, closeDeck]);

  const sendDeckKey = useCallback(
    (key: DeckKey) => {
      sendRaw(key.sequence);
      setLastKey(key);
      afterDeckAction();
    },
    [sendRaw, afterDeckAction],
  );

  const sendDeckSequence = useCallback(
    (sequence: string) => {
      sendRaw(sequence);
      afterDeckAction();
    },
    [sendRaw, afterDeckAction],
  );

  // ⌃⇧K summons the menu. Ctrl+Shift+<letter> is safe to steal: it isn't a
  // distinct control code, so no TUI underneath can be listening for it.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.ctrlKey || !e.shiftKey || e.metaKey || e.altKey) return;
      if (e.key !== "K" && e.key !== "k") return;
      const host = hostRef.current;
      if (!host || !host.isConnected) return;
      e.preventDefault();
      e.stopPropagation();
      if (deckOpenRef.current) closeDeck();
      else openDeck();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [openDeck, closeDeck]);

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
      const url = `${proto}//${location.host}/api/term?${connTarget}&cols=${term.cols}&rows=${term.rows}`;
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
      term = new GhosttyTerminal({
        fontSize: 13,
        scrollback: 8000,
        cursorBlink: true,
        theme: TERMINAL_THEME,
      });
      fit = new FitAddon();
      term.loadAddon(fit);
      term.open(hostRef.current);
      cleanupMouseReporting = installMouseReporting(hostRef.current, term, sendRaw);
      tameTerminalInput(term);
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

      // Refit only when the box really changed size. iOS republishes viewport
      // metrics many times while the soft keyboard animates (and the app shell
      // re-samples deliberately for a settle window afterwards), and each
      // refit reflows the grid, resizes the pty and makes tmux repaint the
      // pane — which reads as the terminal flickering up and down. Sub-pixel
      // and no-op notifications are the common case, so drop them.
      let lastW = 0;
      let lastH = 0;
      ro = new ResizeObserver((entries) => {
        const box = entries[entries.length - 1]?.contentRect;
        if (box) {
          const w = Math.round(box.width);
          const h = Math.round(box.height);
          if (w === lastW && h === lastH) return;
          lastW = w;
          lastH = h;
        }
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
    // Re-attaching to a different shell (another session's terminal, or a new
    // free-form name) rebuilds the terminal and its socket.
  }, [sendRaw, connTarget]);

  // Detect links by polling tmux's logical buffer (wrapped lines rejoined), so
  // long URLs survive — the rendered stream breaks them at every wrap. Cheap
  // and only runs while the tab is mounted.
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const r = await lfgFetch(`/api/term/scan?${connTarget}`);
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
  }, [connTarget]);

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
    <div className="relative flex h-full flex-col overflow-hidden rounded-2xl border border-border bg-[#0b0b0d]">
      {/* One slim strip is the terminal's entire permanent chrome — everything
          else lives in the deck, summoned only when it's wanted. */}
      <div className="flex items-center gap-2 border-b border-white/10 px-2.5 py-1 text-[11px] text-white/55">
        <TerminalSquare className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate font-medium text-white/75">
          {label ?? `terminal · ${termSession}`}
        </span>
        <span
          className={`inline-flex shrink-0 items-center gap-1 ${
            status === "open"
              ? "text-emerald-400"
              : status === "closed"
                ? "text-destructive"
                : "text-white/50"
          }`}
          title={`terminal ${status}`}
        >
          <span className="size-1.5 rounded-full bg-current" />
          <span className="hidden sm:inline">{status}</span>
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => (deckOpen ? closeDeck() : openDeck())}
            style={{ touchAction: "manipulation" }}
            aria-pressed={deckOpen}
            aria-label="Terminal keys"
            title="Terminal keys (⌃⇧K)"
            className={`flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium ${
              deckOpen ? "bg-white text-black" : "bg-white/10 text-white/70 active:bg-white/25"
            }`}
          >
            <Keyboard className="size-3.5" />
            <span className="hidden sm:inline">Keys</span>
            <kbd
              className={`hidden font-mono text-[9px] md:inline ${
                deckOpen ? "text-black/45" : "text-white/35"
              }`}
            >
              ⌃⇧K
            </kbd>
          </button>
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              style={{ touchAction: "manipulation" }}
              aria-label="Close terminal"
              title="Close terminal"
              className="grid size-6 place-items-center rounded-md bg-white/10 text-white/60 active:bg-white/25"
            >
              <X className="size-3.5" />
            </button>
          ) : null}
        </div>
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

      {/* Grab handle: the one always-visible hint that there are more keys, and
          the target the bottom-edge swipe-up starts from. 10px of chrome
          instead of the ~110px toolbar it replaces. */}
      {!deckOpen ? (
        <button
          type="button"
          onClick={openDeck}
          style={{ touchAction: "manipulation" }}
          aria-label="Show terminal keys"
          title="Terminal keys (⌃⇧K, or swipe up)"
          className="absolute inset-x-0 bottom-0 z-20 flex h-6 items-end justify-center pb-1"
        >
          <span className="h-1 w-10 rounded-full bg-white/20" />
        </button>
      ) : null}

      <KeyDeck
        open={deckOpen}
        sticky={deckSticky}
        lastKey={lastKey}
        onSendKey={sendDeckKey}
        onSendSequence={sendDeckSequence}
        onPaste={() => {
          void doPaste();
          afterDeckAction();
        }}
        onInsert={enterInsertMode}
        onToggleSticky={toggleDeckSticky}
        onClose={closeDeck}
      />

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
        <div className="fixed inset-x-0 bottom-0 z-50 flex items-center gap-2 border-t border-white/10 bg-[#0b0b0d] p-2 pb-[calc(0.5rem+var(--lfg-safe-bottom))]">
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
