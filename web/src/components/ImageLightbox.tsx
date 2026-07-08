import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from "react";
import { createPortal } from "react-dom";
import { Minus, Plus, RotateCcw, X } from "lucide-react";
import { cn } from "@/lib/utils";

const MIN_SCALE = 1;
const MAX_SCALE = 8;
const DOUBLE_CLICK_SCALE = 2.5;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

type View = { scale: number; ox: number; oy: number };

const RESET: View = { scale: 1, ox: 0, oy: 0 };

/**
 * Full-screen click-to-zoom viewer for a single image. Renders through a portal
 * so it escapes the chat's overflow/stacking context. Zoom is anchored to the
 * cursor (wheel + double-click); drag pans once zoomed in.
 */
export function ImageLightbox({
  src,
  alt,
  open,
  onClose,
}: {
  src: string;
  alt?: string;
  open: boolean;
  onClose: () => void;
}) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [view, setView] = useState<View>(RESET);
  // Live screen position of every active pointer, keyed by pointerId. One entry
  // = drag-to-pan; two = pinch-zoom. Last pinch distance/midpoint lets us turn
  // each move into a scale ratio + pan delta.
  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinch = useRef<{ dist: number; mx: number; my: number } | null>(null);
  // Whether the current gesture moved enough to count as a pan/pinch (so we
  // don't treat a lift as a tap-to-close).
  const moved = useRef(false);
  const [gesturing, setGesturing] = useState(false);

  // Reset the transform every time the viewer (re)opens.
  useEffect(() => {
    if (open) setView(RESET);
  }, [open, src]);

  // Escape to close; lock body scroll while open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  // Zoom toward a screen point (cx, cy), keeping the content under it fixed.
  const zoomAt = useCallback((nextScale: number, cx: number, cy: number) => {
    const el = imgRef.current;
    if (!el) return;
    setView((v) => {
      const target = clamp(nextScale, MIN_SCALE, MAX_SCALE);
      if (target === MIN_SCALE) return RESET;
      const rect = el.getBoundingClientRect();
      // Offset of the cursor from the element's current painted top-left.
      const dx = cx - rect.left;
      const dy = cy - rect.top;
      const ratio = target / v.scale;
      return {
        scale: target,
        ox: v.ox + dx * (1 - ratio),
        oy: v.oy + dy * (1 - ratio),
      };
    });
  }, []);

  const onWheel = useCallback(
    (e: ReactWheelEvent<HTMLDivElement>) => {
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * 0.0015);
      setView((v) => {
        const el = imgRef.current;
        if (!el) return v;
        const target = clamp(v.scale * factor, MIN_SCALE, MAX_SCALE);
        if (target === MIN_SCALE) return RESET;
        const rect = el.getBoundingClientRect();
        const dx = e.clientX - rect.left;
        const dy = e.clientY - rect.top;
        const ratio = target / v.scale;
        return { scale: target, ox: v.ox + dx * (1 - ratio), oy: v.oy + dy * (1 - ratio) };
      });
    },
    [],
  );

  function onPointerDown(e: ReactPointerEvent<HTMLImageElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved.current = false;
    setGesturing(true);
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = {
        dist: Math.hypot(a.x - b.x, a.y - b.y),
        mx: (a.x + b.x) / 2,
        my: (a.y + b.y) / 2,
      };
    }
  }

  function onPointerMove(e: ReactPointerEvent<HTMLImageElement>) {
    const map = pointers.current;
    const prev = map.get(e.pointerId);
    if (!prev) return;
    const next = { x: e.clientX, y: e.clientY };
    map.set(e.pointerId, next);

    // Two fingers → pinch-zoom anchored at the midpoint, plus follow the
    // midpoint's drift so the gesture pans at the same time.
    if (map.size >= 2 && pinch.current) {
      const [a, b] = [...map.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const el = imgRef.current;
      if (el && pinch.current.dist > 0) {
        const rect = el.getBoundingClientRect();
        const ratio = dist / pinch.current.dist;
        const panX = mx - pinch.current.mx;
        const panY = my - pinch.current.my;
        const dx = mx - rect.left;
        const dy = my - rect.top;
        setView((v) => {
          const target = clamp(v.scale * ratio, MIN_SCALE, MAX_SCALE);
          if (target === MIN_SCALE) return RESET;
          const r = target / v.scale;
          return {
            scale: target,
            ox: v.ox + dx * (1 - r) + panX,
            oy: v.oy + dy * (1 - r) + panY,
          };
        });
        moved.current = true;
      }
      pinch.current = { dist, mx, my };
      return;
    }

    // One finger / mouse → pan, but only once zoomed in.
    if (map.size === 1) {
      const dx = next.x - prev.x;
      const dy = next.y - prev.y;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved.current = true;
      setView((v) => (v.scale <= MIN_SCALE ? v : { ...v, ox: v.ox + dx, oy: v.oy + dy }));
    }
  }

  function onPointerUp(e: ReactPointerEvent<HTMLImageElement>) {
    const map = pointers.current;
    map.delete(e.pointerId);
    if (map.size < 2) pinch.current = null;
    if (map.size === 0) {
      setGesturing(false);
      // A clean tap (no pan/pinch) while not zoomed dismisses the viewer.
      if (!moved.current && view.scale <= MIN_SCALE) onClose();
    }
  }

  function onDoubleClick(e: ReactPointerEvent<HTMLImageElement>) {
    if (view.scale > MIN_SCALE) setView(RESET);
    else zoomAt(DOUBLE_CLICK_SCALE, e.clientX, e.clientY);
  }

  if (!open) return null;

  const zoomed = view.scale > MIN_SCALE;

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onWheel={onWheel}
      onPointerDown={(e) => {
        // Click on the backdrop (not the image) closes.
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label={alt || "Image viewer"}
    >
      {/* Controls */}
      <div className="absolute right-3 top-3 z-10 flex items-center gap-1.5">
        <LightboxButton
          label="Zoom out"
          onClick={() => zoomAt(view.scale / 1.5, window.innerWidth / 2, window.innerHeight / 2)}
          disabled={!zoomed}
        >
          <Minus className="size-4" />
        </LightboxButton>
        <span className="min-w-[3.25rem] select-none text-center text-xs tabular-nums text-white/80">
          {Math.round(view.scale * 100)}%
        </span>
        <LightboxButton
          label="Zoom in"
          onClick={() => zoomAt(view.scale * 1.5, window.innerWidth / 2, window.innerHeight / 2)}
          disabled={view.scale >= MAX_SCALE}
        >
          <Plus className="size-4" />
        </LightboxButton>
        <LightboxButton label="Reset zoom" onClick={() => setView(RESET)} disabled={!zoomed}>
          <RotateCcw className="size-4" />
        </LightboxButton>
        <LightboxButton label="Close" onClick={onClose}>
          <X className="size-4" />
        </LightboxButton>
      </div>

      <img
        ref={imgRef}
        src={src}
        alt={alt || "Image"}
        draggable={false}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
        className={cn(
          "max-h-[92vh] max-w-[92vw] touch-none select-none object-contain",
          zoomed ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-out",
        )}
        style={{
          transform: `translate(${view.ox}px, ${view.oy}px) scale(${view.scale})`,
          transformOrigin: "0 0",
          transition: gesturing ? "none" : "transform 120ms ease-out",
          touchAction: "none",
          willChange: "transform",
        }}
      />
    </div>,
    document.body,
  );
}

function LightboxButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex size-9 items-center justify-center rounded-full bg-white/10 text-white backdrop-blur-sm transition-colors",
        "hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50",
        "disabled:pointer-events-none disabled:opacity-40",
      )}
    >
      {children}
    </button>
  );
}

/**
 * Inline image that opens {@link ImageLightbox} on click. Drop-in for a plain
 * `<img>` in message bubbles.
 */
export function ZoomableImage({
  src,
  alt,
  className,
}: {
  src: string;
  alt?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <img
        src={src}
        alt={alt}
        loading="lazy"
        onClick={() => setOpen(true)}
        className={cn("cursor-zoom-in", className)}
      />
      <ImageLightbox src={src} alt={alt} open={open} onClose={() => setOpen(false)} />
    </>
  );
}
