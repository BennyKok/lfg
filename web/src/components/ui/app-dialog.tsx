import * as React from "react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

type ConfirmOptions = {
  title: string
  description?: string
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
}

type PromptOptions = {
  title: string
  description?: string
  defaultValue?: string
  placeholder?: string
  confirmLabel?: string
  cancelLabel?: string
  inputLabel?: string
}

type DialogRequest =
  | { kind: "confirm"; options: ConfirmOptions; resolve: (value: boolean) => void }
  | { kind: "prompt"; options: PromptOptions; resolve: (value: string | null) => void }

type AppDialogApi = {
  confirm: (options: ConfirmOptions) => Promise<boolean>
  prompt: (options: PromptOptions) => Promise<string | null>
}

const AppDialogContext = React.createContext<AppDialogApi | null>(null)

export function AppDialogProvider({ children }: { children: React.ReactNode }) {
  const [request, setRequest] = React.useState<DialogRequest | null>(null)
  const [promptValue, setPromptValue] = React.useState("")
  const requestRef = React.useRef<DialogRequest | null>(null)

  const finish = React.useCallback((value: boolean | string | null) => {
    const current = requestRef.current
    if (!current) return
    requestRef.current = null
    setRequest(null)
    if (current.kind === "confirm") current.resolve(value === true)
    else current.resolve(typeof value === "string" ? value : null)
  }, [])

  const open = React.useCallback((next: DialogRequest) => {
    const current = requestRef.current
    if (current) {
      if (current.kind === "confirm") current.resolve(false)
      else current.resolve(null)
    }
    requestRef.current = next
    if (next.kind === "prompt") setPromptValue(next.options.defaultValue ?? "")
    setRequest(next)
  }, [])

  React.useEffect(
    () => () => {
      const current = requestRef.current
      if (current?.kind === "confirm") current.resolve(false)
      else current?.resolve(null)
    },
    [],
  )

  const api = React.useMemo<AppDialogApi>(
    () => ({
      confirm: (options) =>
        new Promise<boolean>((resolve) => open({ kind: "confirm", options, resolve })),
      prompt: (options) =>
        new Promise<string | null>((resolve) => open({ kind: "prompt", options, resolve })),
    }),
    [open],
  )

  return (
    <AppDialogContext.Provider value={api}>
      {children}
      <AlertDialog
        open={request?.kind === "confirm"}
        onOpenChange={(isOpen) => {
          if (!isOpen && requestRef.current?.kind === "confirm") finish(false)
        }}
      >
        {request?.kind === "confirm" ? (
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{request.options.title}</AlertDialogTitle>
              {request.options.description ? (
                <AlertDialogDescription>{request.options.description}</AlertDialogDescription>
              ) : null}
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel onClick={() => finish(false)}>
                {request.options.cancelLabel ?? "Cancel"}
              </AlertDialogCancel>
              <AlertDialogAction
                variant={request.options.destructive ? "destructive" : "default"}
                onClick={() => finish(true)}
              >
                {request.options.confirmLabel ?? "Continue"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        ) : null}
      </AlertDialog>

      <Dialog
        open={request?.kind === "prompt"}
        onOpenChange={(isOpen) => {
          if (!isOpen && requestRef.current?.kind === "prompt") finish(null)
        }}
      >
        {request?.kind === "prompt" ? (
          <DialogContent showCloseButton={false}>
            <form
              className="grid gap-6"
              onSubmit={(event) => {
                event.preventDefault()
                finish(promptValue)
              }}
            >
              <DialogHeader>
                <DialogTitle>{request.options.title}</DialogTitle>
                {request.options.description ? (
                  <DialogDescription>{request.options.description}</DialogDescription>
                ) : null}
              </DialogHeader>
              <input
                autoFocus
                aria-label={request.options.inputLabel ?? request.options.title}
                value={promptValue}
                onChange={(event) => setPromptValue(event.target.value)}
                placeholder={request.options.placeholder}
                className="h-10 w-full rounded-xl border border-input bg-background px-3 text-sm outline-none transition-shadow focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              />
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => finish(null)}>
                  {request.options.cancelLabel ?? "Cancel"}
                </Button>
                <Button type="submit">{request.options.confirmLabel ?? "Continue"}</Button>
              </DialogFooter>
            </form>
          </DialogContent>
        ) : null}
      </Dialog>
    </AppDialogContext.Provider>
  )
}

export function useAppDialog(): AppDialogApi {
  const context = React.useContext(AppDialogContext)
  if (!context) throw new Error("useAppDialog must be used within AppDialogProvider")
  return context
}
