"use client"

import * as React from "react"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { XIcon } from "lucide-react"

function Dialog({ ...props }: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({ ...props }: DialogPrimitive.Portal.Props) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  ...props
}: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-overlay"
      className={cn(
        // z-[160] sits above every app-level sheet and drawer (the full-screen
        // session sheet is z-[90], menus are z-[120], and the tallest drawers
        // are z-[150]). A Dialog opened from one of those surfaces must remain
        // visible and receive clicks.
        //
        // pointer-events-auto is critical: vaul (the Drawer lib) sets
        // `pointer-events: none` on <body> while a Drawer is open, and
        // base-ui portals our Dialog content as a descendant of body —
        // without overriding here every click is dropped silently.
        "pointer-events-auto fixed inset-0 isolate z-[160] bg-black/80 duration-100 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
        className
      )}
      {...props}
    />
  )
}

/**
 * Hook that observes a container's height via ResizeObserver and applies
 * an explicit height to a target element so that CSS `transition: height`
 * can smoothly animate content-driven size changes.
 */
function useAnimatedHeight() {
  const popupRef = React.useRef<HTMLDivElement>(null)
  const innerRef = React.useRef<HTMLDivElement>(null)
  const initializedRef = React.useRef(false)

  React.useEffect(() => {
    const popup = popupRef.current
    const inner = innerRef.current
    if (!popup || !inner) return

    const ro = new ResizeObserver(([entry]) => {
      const height = entry.borderBoxSize[0].blockSize
      if (!initializedRef.current) {
        // First measurement — set height without transition so the open
        // animation isn't affected.
        initializedRef.current = true
        popup.style.height = `${height}px`
        return
      }
      popup.style.height = `${height}px`
    })

    ro.observe(inner)
    return () => {
      ro.disconnect()
      initializedRef.current = false
    }
  }, [])

  return { popupRef, innerRef }
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  innerClassName,
  overlayClassName,
  onKeyDown,
  ...props
}: DialogPrimitive.Popup.Props & {
  showCloseButton?: boolean
  innerClassName?: string
  overlayClassName?: string
}) {
  const { popupRef, innerRef } = useAnimatedHeight()

  return (
    <DialogPortal>
      <DialogOverlay className={overlayClassName} />
      <DialogPrimitive.Popup
        ref={popupRef}
        data-slot="dialog-content"
        onKeyDown={(event) => {
          // A portalled dialog can still bubble keyboard events to document-level
          // app shortcuts. Keep Escape/arrows/etc. from controlling the screen
          // underneath the active modal.
          event.stopPropagation()
          onKeyDown?.(event)
          if (event.defaultPrevented || event.nativeEvent.isComposing) return
          if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
          if (event.key !== "Enter") return

          const target = event.target as HTMLElement
          if (
            target.closest("input, textarea, select, button, a, [contenteditable='true']")
          ) return

          // Enter from non-editable dialog content activates the trailing footer
          // button, which is the primary action by convention. Tab/Shift+Tab and
          // Escape continue to be handled by Base UI's focus trap and dismiss logic.
          const footer = event.currentTarget.querySelector<HTMLElement>(
            "[data-slot='dialog-footer']",
          )
          const actions = footer
            ? Array.from(footer.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"))
            : []
          const primary = actions.at(-1)
          if (!primary) return
          event.preventDefault()
          primary.click()
        }}
        className={cn(
          "pointer-events-auto fixed top-1/2 left-1/2 z-[160] w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-4xl bg-background text-sm ring-1 ring-foreground/5 duration-100 outline-none sm:max-w-md data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className
        )}
        {...props}
      >
        <div ref={innerRef} className={cn("grid gap-6 p-6", innerClassName)}>
          {children}
          {showCloseButton && (
            <DialogPrimitive.Close
              data-slot="dialog-close"
              render={
                <Button
                  variant="ghost"
                  className="absolute top-4 right-4"
                  size="icon-sm"
                />
              }
            >
              <XIcon
              />
              <span className="sr-only">Close</span>
            </DialogPrimitive.Close>
          )}
        </div>
      </DialogPrimitive.Popup>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2", className)}
      {...props}
    />
  )
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close render={<Button variant="outline" />}>
          Close
        </DialogPrimitive.Close>
      )}
    </div>
  )
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn(
        "font-heading text-base leading-none font-medium",
        className
      )}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        "text-sm text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
        className
      )}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
