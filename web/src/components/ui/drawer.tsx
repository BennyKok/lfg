"use client"

import * as React from "react"
import { Drawer as DrawerPrimitive } from "vaul"

import { cn } from "@/lib/utils"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"

// On desktop we present these surfaces as a centered dialog instead of a
// bottom-sheet drawer — a slide-up sheet reads as a mobile affordance and
// wastes horizontal space on wide viewports. On mobile (coarse pointer /
// narrow width) we keep the vaul drawer with its drag handle. All callers use
// the same <Drawer>/<DrawerContent>/<DrawerTitle> API, so switching here flips
// every "app drawer" (new session, finding sheet, notepad) at once.
function useIsDesktopDrawer() {
  const query = "(min-width: 768px)"
  const [isDesktop, setIsDesktop] = React.useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches
  )
  React.useEffect(() => {
    const mq = window.matchMedia(query)
    const onChange = () => setIsDesktop(mq.matches)
    onChange()
    mq.addEventListener("change", onChange)
    return () => mq.removeEventListener("change", onChange)
  }, [])
  return isDesktop
}

const DrawerDesktopContext = React.createContext(false)

function Drawer({
  // vaul-only props that base-ui's Dialog root doesn't understand — pull them
  // off so they don't leak onto the dialog path.
  repositionInputs: _repositionInputs,
  shouldScaleBackground: _shouldScaleBackground,
  snapPoints: _snapPoints,
  fadeFromIndex: _fadeFromIndex,
  direction: _direction,
  handleOnly: _handleOnly,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Root>) {
  const isDesktop = useIsDesktopDrawer()

  if (isDesktop) {
    const { open, defaultOpen, onOpenChange, modal, children } = props
    return (
      <DrawerDesktopContext.Provider value={true}>
        <Dialog
          open={open}
          defaultOpen={defaultOpen}
          onOpenChange={onOpenChange}
          modal={modal}
        >
          {children}
        </Dialog>
      </DrawerDesktopContext.Provider>
    )
  }

  return (
    <DrawerDesktopContext.Provider value={false}>
      <DrawerPrimitive.Root data-slot="drawer" {...props} />
    </DrawerDesktopContext.Provider>
  )
}

function DrawerTrigger({
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Trigger>) {
  const isDesktop = React.useContext(DrawerDesktopContext)
  if (isDesktop) return <DialogTrigger data-slot="drawer-trigger" {...props} />
  return <DrawerPrimitive.Trigger data-slot="drawer-trigger" {...props} />
}

function DrawerPortal({
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Portal>) {
  return <DrawerPrimitive.Portal data-slot="drawer-portal" {...props} />
}

function DrawerClose({
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Close>) {
  const isDesktop = React.useContext(DrawerDesktopContext)
  if (isDesktop) return <DialogClose data-slot="drawer-close" {...props} />
  return <DrawerPrimitive.Close data-slot="drawer-close" {...props} />
}

function DrawerOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Overlay>) {
  return (
    <DrawerPrimitive.Overlay
      data-slot="drawer-overlay"
      className={cn(
        "fixed inset-0 z-[70] bg-black/80 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
        className
      )}
      {...props}
    />
  )
}

function DrawerContent({
  className,
  overlayClassName,
  children,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Content> & {
  overlayClassName?: string
}) {
  const isDesktop = React.useContext(DrawerDesktopContext)

  if (isDesktop) {
    return (
      <DialogContent
        data-slot="drawer-content"
        showCloseButton={false}
        overlayClassName={overlayClassName}
        // Cap height so tall content scrolls inside the dialog instead of
        // overflowing the viewport; callers already carry their own inner
        // scroll containers.
        className={cn("max-h-[85dvh] overflow-hidden", className)}
        innerClassName="block max-h-[85dvh] overflow-y-auto p-4"
        {...(props as React.ComponentProps<typeof DialogContent>)}
      >
        {children}
      </DialogContent>
    )
  }

  return (
    <DrawerPortal data-slot="drawer-portal">
      <DrawerOverlay className={overlayClassName} />
      <DrawerPrimitive.Content
        data-slot="drawer-content"
        className={cn(
          "group/drawer-content fixed z-[70] flex h-auto flex-col bg-transparent p-4 text-sm before:absolute before:inset-2 before:-z-10 before:rounded-4xl before:border before:border-border before:bg-background data-[vaul-drawer-direction=bottom]:inset-x-0 data-[vaul-drawer-direction=bottom]:bottom-0 data-[vaul-drawer-direction=bottom]:mt-24 data-[vaul-drawer-direction=bottom]:max-h-[80vh] data-[vaul-drawer-direction=left]:inset-y-0 data-[vaul-drawer-direction=left]:left-0 data-[vaul-drawer-direction=left]:w-3/4 data-[vaul-drawer-direction=right]:inset-y-0 data-[vaul-drawer-direction=right]:right-0 data-[vaul-drawer-direction=right]:w-3/4 data-[vaul-drawer-direction=top]:inset-x-0 data-[vaul-drawer-direction=top]:top-0 data-[vaul-drawer-direction=top]:mb-24 data-[vaul-drawer-direction=top]:max-h-[80vh] data-[vaul-drawer-direction=left]:sm:max-w-sm data-[vaul-drawer-direction=right]:sm:max-w-sm",
          className
        )}
        {...props}
      >
        <div className="mx-auto mt-4 hidden h-1.5 w-[100px] shrink-0 rounded-full bg-muted group-data-[vaul-drawer-direction=bottom]/drawer-content:block" />
        {children}
      </DrawerPrimitive.Content>
    </DrawerPortal>
  )
}

function DrawerHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="drawer-header"
      className={cn(
        "flex flex-col gap-0.5 p-4 group-data-[vaul-drawer-direction=bottom]/drawer-content:text-center group-data-[vaul-drawer-direction=top]/drawer-content:text-center md:gap-1.5 md:text-left",
        className
      )}
      {...props}
    />
  )
}

function DrawerFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="drawer-footer"
      className={cn("mt-auto flex flex-col gap-2 p-4", className)}
      {...props}
    />
  )
}

function DrawerTitle({
  className,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Title>) {
  const isDesktop = React.useContext(DrawerDesktopContext)
  if (isDesktop) {
    return (
      <DialogTitle
        data-slot="drawer-title"
        className={cn(
          "font-heading text-base font-medium text-foreground",
          className
        )}
        {...(props as React.ComponentProps<typeof DialogTitle>)}
      />
    )
  }
  return (
    <DrawerPrimitive.Title
      data-slot="drawer-title"
      className={cn(
        "font-heading text-base font-medium text-foreground",
        className
      )}
      {...props}
    />
  )
}

function DrawerDescription({
  className,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Description>) {
  const isDesktop = React.useContext(DrawerDesktopContext)
  if (isDesktop) {
    return (
      <DialogDescription
        data-slot="drawer-description"
        className={cn("text-sm text-muted-foreground", className)}
        {...(props as React.ComponentProps<typeof DialogDescription>)}
      />
    )
  }
  return (
    <DrawerPrimitive.Description
      data-slot="drawer-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Drawer,
  DrawerPortal,
  DrawerOverlay,
  DrawerTrigger,
  DrawerClose,
  DrawerContent,
  DrawerHeader,
  DrawerFooter,
  DrawerTitle,
  DrawerDescription,
}
