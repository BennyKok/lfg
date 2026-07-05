import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import {
  ArrowUpRight,
  Circle,
  Eraser,
  Pencil,
  Redo2,
  Square,
  Type,
  Undo2,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Tool = "pen" | "rect" | "circle" | "arrow" | "text";

type Point = { x: number; y: number };

type Shape =
  | { type: "path"; points: Point[]; color: string; width: number }
  | { type: "rect"; x0: number; y0: number; x1: number; y1: number; color: string; width: number }
  | { type: "circle"; x0: number; y0: number; x1: number; y1: number; color: string; width: number }
  | { type: "arrow"; x0: number; y0: number; x1: number; y1: number; color: string; width: number }
  | { type: "text"; x: number; y: number; text: string; color: string; fontSize: number };

const COLORS = [
  "#ef4444", // red
  "#f59e0b", // amber
  "#22c55e", // green
  "#3b82f6", // blue
  "#a855f7", // purple
  "#ffffff", // white
  "#111827", // near-black
];

const TOOLS: { id: Tool; label: string; icon: typeof Pencil }[] = [
  { id: "pen", label: "Draw", icon: Pencil },
  { id: "circle", label: "Circle", icon: Circle },
  { id: "rect", label: "Box", icon: Square },
  { id: "arrow", label: "Arrow", icon: ArrowUpRight },
  { id: "text", label: "Text", icon: Type },
];

function drawShape(ctx: CanvasRenderingContext2D, shape: Shape) {
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  if (shape.type === "text") {
    ctx.font = `700 ${shape.fontSize}px ui-sans-serif, system-ui, sans-serif`;
    ctx.fillStyle = shape.color;
    ctx.textBaseline = "top";
    ctx.fillText(shape.text, shape.x, shape.y);
    return;
  }
  ctx.strokeStyle = shape.color;
  ctx.lineWidth = shape.width;
  if (shape.type === "path") {
    if (shape.points.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(shape.points[0].x, shape.points[0].y);
    for (const p of shape.points.slice(1)) ctx.lineTo(p.x, p.y);
    ctx.stroke();
    return;
  }
  if (shape.type === "rect") {
    const x = Math.min(shape.x0, shape.x1);
    const y = Math.min(shape.y0, shape.y1);
    ctx.strokeRect(x, y, Math.abs(shape.x1 - shape.x0), Math.abs(shape.y1 - shape.y0));
    return;
  }
  if (shape.type === "circle") {
    const cx = (shape.x0 + shape.x1) / 2;
    const cy = (shape.y0 + shape.y1) / 2;
    const rx = Math.abs(shape.x1 - shape.x0) / 2;
    const ry = Math.abs(shape.y1 - shape.y0) / 2;
    ctx.beginPath();
    ctx.ellipse(cx, cy, Math.max(rx, 1), Math.max(ry, 1), 0, 0, Math.PI * 2);
    ctx.stroke();
    return;
  }
  if (shape.type === "arrow") {
    const { x0, y0, x1, y1 } = shape;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    const angle = Math.atan2(y1 - y0, x1 - x0);
    const headLen = Math.max(shape.width * 4, 14);
    const spread = 0.45;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x1 - headLen * Math.cos(angle - spread), y1 - headLen * Math.sin(angle - spread));
    ctx.moveTo(x1, y1);
    ctx.lineTo(x1 - headLen * Math.cos(angle + spread), y1 - headLen * Math.sin(angle + spread));
    ctx.stroke();
  }
}

export function ImageAnnotator({
  open,
  file,
  onOpenChange,
  onSave,
}: {
  open: boolean;
  file: File | null;
  onOpenChange: (open: boolean) => void;
  onSave: (file: File) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState(COLORS[0]);
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [redoStack, setRedoStack] = useState<Shape[]>([]);
  const [draft, setDraft] = useState<Shape | null>(null);
  const [pendingText, setPendingText] = useState<{ x: number; y: number; cssLeft: number; cssTop: number } | null>(
    null,
  );
  const [textValue, setTextValue] = useState("");
  const [saving, setSaving] = useState(false);

  const strokeWidth = useMemo(
    () => (naturalSize ? Math.max(4, Math.round(naturalSize.w / 220)) : 6),
    [naturalSize],
  );
  const fontSize = useMemo(
    () => (naturalSize ? Math.max(18, Math.round(naturalSize.w / 22)) : 24),
    [naturalSize],
  );

  // Load the source image whenever the dialog opens with a new file.
  useEffect(() => {
    if (!open || !file) return;
    let cancelled = false;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      imgRef.current = img;
      setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
      setShapes([]);
      setRedoStack([]);
      setDraft(null);
      setPendingText(null);
    };
    img.src = url;
    return () => {
      cancelled = true;
      URL.revokeObjectURL(url);
    };
  }, [open, file]);

  // Redraw the base image plus every committed/in-progress shape.
  useEffect(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img || !naturalSize) return;
    canvas.width = naturalSize.w;
    canvas.height = naturalSize.h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);
    for (const shape of shapes) drawShape(ctx, shape);
    if (draft) drawShape(ctx, draft);
  }, [naturalSize, shapes, draft]);

  function getCanvasPos(e: ReactPointerEvent<HTMLCanvasElement>): Point {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
  }

  function handlePointerDown(e: ReactPointerEvent<HTMLCanvasElement>) {
    if (!naturalSize) return;
    const pos = getCanvasPos(e);
    if (tool === "text") {
      const canvas = canvasRef.current;
      const rect = canvas?.getBoundingClientRect();
      setPendingText({
        x: pos.x,
        y: pos.y,
        cssLeft: rect ? e.clientX - rect.left : 0,
        cssTop: rect ? e.clientY - rect.top : 0,
      });
      setTextValue("");
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    setRedoStack([]);
    if (tool === "pen") {
      setDraft({ type: "path", points: [pos], color, width: strokeWidth });
    } else {
      setDraft({ type: tool, x0: pos.x, y0: pos.y, x1: pos.x, y1: pos.y, color, width: strokeWidth });
    }
  }

  function handlePointerMove(e: ReactPointerEvent<HTMLCanvasElement>) {
    if (!draft) return;
    const pos = getCanvasPos(e);
    setDraft((current) => {
      if (!current) return current;
      if (current.type === "path") return { ...current, points: [...current.points, pos] };
      if (current.type === "text") return current;
      return { ...current, x1: pos.x, y1: pos.y };
    });
  }

  function commitDraft() {
    if (!draft) return;
    setShapes((current) => [...current, draft]);
    setDraft(null);
  }

  function commitText() {
    if (pendingText && textValue.trim()) {
      setShapes((current) => [
        ...current,
        { type: "text", x: pendingText.x, y: pendingText.y, text: textValue.trim(), color, fontSize },
      ]);
      setRedoStack([]);
    }
    setPendingText(null);
    setTextValue("");
  }

  function undo() {
    setShapes((current) => {
      if (!current.length) return current;
      const last = current[current.length - 1];
      setRedoStack((redo) => [...redo, last]);
      return current.slice(0, -1);
    });
  }

  function redo() {
    setRedoStack((current) => {
      if (!current.length) return current;
      const last = current[current.length - 1];
      setShapes((shapes) => [...shapes, last]);
      return current.slice(0, -1);
    });
  }

  function clearAll() {
    setShapes([]);
    setRedoStack([]);
  }

  async function handleSave() {
    const canvas = canvasRef.current;
    if (!canvas || !file) return;
    setSaving(true);
    canvas.toBlob((blob) => {
      setSaving(false);
      if (!blob) return;
      const baseName = file.name.replace(/\.[^./]+$/, "") || "image";
      const annotated = new File([blob], `${baseName}-annotated.png`, { type: "image/png" });
      onSave(annotated);
    }, "image/png");
  }

  const hasMarks = shapes.length > 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setPendingText(null);
        onOpenChange(next);
      }}
    >
      <DialogContent
        className="z-[130] max-w-[min(94vw,64rem)] sm:max-w-[min(94vw,64rem)]"
        overlayClassName="z-[130]"
        showCloseButton
      >
        <DialogHeader>
          <DialogTitle>Annotate image</DialogTitle>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1 rounded-full bg-muted/60 p-1">
            {TOOLS.map(({ id, label, icon: Icon }) => (
              <Button
                key={id}
                type="button"
                size="icon-sm"
                variant={tool === id ? "default" : "ghost"}
                aria-label={label}
                title={label}
                onClick={() => {
                  setPendingText(null);
                  setTool(id);
                }}
              >
                <Icon className="size-4" />
              </Button>
            ))}
          </div>

          <div className="flex items-center gap-1.5">
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={`Color ${c}`}
                onClick={() => setColor(c)}
                className={cn(
                  "size-6 shrink-0 rounded-full ring-1 ring-border/60 transition-transform",
                  color === c && "scale-110 ring-2 ring-foreground",
                )}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>

          <div className="ml-auto flex items-center gap-1">
            <Button type="button" size="icon-sm" variant="ghost" title="Undo" aria-label="Undo" onClick={undo} disabled={!hasMarks}>
              <Undo2 className="size-4" />
            </Button>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              title="Redo"
              aria-label="Redo"
              onClick={redo}
              disabled={!redoStack.length}
            >
              <Redo2 className="size-4" />
            </Button>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              title="Clear all"
              aria-label="Clear all"
              onClick={clearAll}
              disabled={!hasMarks}
            >
              <Eraser className="size-4" />
            </Button>
          </div>
        </div>

        <div className="relative flex max-h-[65vh] items-center justify-center overflow-auto rounded-2xl bg-black/5">
          <canvas
            ref={canvasRef}
            className="max-h-[65vh] max-w-full touch-none rounded-2xl"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={commitDraft}
            onPointerLeave={commitDraft}
            onPointerCancel={commitDraft}
          />
          {pendingText ? (
            <input
              autoFocus
              value={textValue}
              onChange={(e) => setTextValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitText();
                if (e.key === "Escape") {
                  setPendingText(null);
                  setTextValue("");
                }
              }}
              onBlur={commitText}
              placeholder="Type a note…"
              className="absolute z-10 rounded-md border border-border bg-background px-2 py-1 text-sm shadow-md outline-none"
              style={{ left: pendingText.cssLeft, top: pendingText.cssTop, color }}
            />
          ) : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void handleSave()} disabled={saving || !naturalSize}>
            {saving ? "Saving…" : "Save annotations"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
