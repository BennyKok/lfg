import * as React from "react"
import { PlusIcon } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * Plus → menu morph (transitions.dev #20).
 *
 * A circular trigger that *becomes* the panel it opens: the box grows and
 * relaxes its corner radius while the plus cross-fades and rotates out and the
 * menu slides in. Reach for this over `DropdownMenu` only when the trigger and
 * the surface are conceptually the same element; when the surface is a distinct
 * popover anchored to a button, `DropdownMenu` is the right primitive.
 *
 * The open footprint can't be derived from content — width/height animate, so
 * they need concrete values. Pass `width`/`height` to match your panel.
 */
function MorphMenu({
  children,
  className,
  width = 183,
  height = 172,
  open: controlledOpen,
  onOpenChange,
  label = "Open menu",
  icon,
  style,
  ...props
}: Omit<React.ComponentProps<"div">, "onChange"> & {
  width?: number | string
  height?: number | string
  open?: boolean
  onOpenChange?: (open: boolean) => void
  label?: string
  icon?: React.ReactNode
}) {
  const ref = React.useRef<HTMLDivElement>(null)
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(false)
  const isControlled = controlledOpen !== undefined
  const open = isControlled ? controlledOpen : uncontrolledOpen

  // Keep the latest onOpenChange in a ref so the dismiss listeners below can
  // stay mounted once instead of re-subscribing on every parent render.
  const onOpenChangeRef = React.useRef(onOpenChange)
  React.useEffect(() => {
    onOpenChangeRef.current = onOpenChange
  })

  const setOpen = React.useCallback(
    (next: boolean) => {
      if (!isControlled) setUncontrolledOpen(next)
      onOpenChangeRef.current?.(next)
    },
    [isControlled],
  )

  // Dismiss on outside pointer-down and Escape. Only mounted while open, so a
  // page full of closed morph menus costs nothing.
  React.useEffect(() => {
    if (!open) return
    function onPointerDown(e: PointerEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false)
    }
    document.addEventListener("pointerdown", onPointerDown)
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("pointerdown", onPointerDown)
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [open, setOpen])

  return (
    <div
      ref={ref}
      data-slot="morph-menu"
      data-open={open}
      className={cn(
        "bg-popover text-popover-foreground ring-1 ring-foreground/5",
        "lfg-morph",
        className,
      )}
      style={
        {
          "--morph-w": typeof width === "number" ? `${width}px` : width,
          "--morph-h": typeof height === "number" ? `${height}px` : height,
          ...style,
        } as React.CSSProperties
      }
      {...props}
    >
      <div data-slot="morph-menu-content" className="lfg-morph-menu">
        {children}
      </div>
      <button
        type="button"
        data-slot="morph-menu-trigger"
        aria-expanded={open}
        aria-label={label}
        className="lfg-morph-plus text-foreground"
        onClick={(e) => {
          e.stopPropagation()
          setOpen(!open)
        }}
      >
        {icon ?? <PlusIcon className="size-5" />}
      </button>
    </div>
  )
}

export { MorphMenu }
