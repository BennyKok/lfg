import {
  cloneElement,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
} from "react"
import { Loader2 } from "lucide-react"

import { feedback } from "@/lib/feedback"

type ConfirmableElementProps = {
  "aria-label"?: string
  children?: ReactNode
  closeOnClick?: boolean
  disabled?: boolean
  label?: string
  onClick?: (event: ReactMouseEvent<HTMLElement>) => void
}

type DoubleConfirmActionProps = {
  /** The button or menu-item primitive that owns the interaction. */
  render: ReactElement<ConfirmableElementProps>
  label: string
  confirmLabel: string
  pendingLabel?: string
  icon?: ReactNode
  confirmIcon?: ReactNode
  onConfirm: () => void | Promise<void>
  disabled?: boolean
  resetKey?: string | number | null
  timeoutMs?: number
}

/**
 * Reusable two-step confirmation for destructive or consequential actions.
 *
 * The first activation arms the control in place and keeps a menu open. A
 * second activation runs the action and lets the menu close normally. The
 * armed state expires automatically, so an old confirmation cannot linger.
 */
function DoubleConfirmAction({
  render,
  label,
  confirmLabel,
  pendingLabel = "Working…",
  icon,
  confirmIcon,
  onConfirm,
  disabled = false,
  resetKey,
  timeoutMs = 3_000,
}: DoubleConfirmActionProps) {
  const [armed, setArmed] = useState(false)
  const [pending, setPending] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearTimer = () => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = null
  }

  const disarm = () => {
    clearTimer()
    setArmed(false)
  }

  useEffect(() => {
    disarm()
    setPending(false)
    return clearTimer
    // resetKey deliberately lets callers disarm when the action target changes.
  }, [resetKey])

  const displayedLabel = pending ? pendingLabel : armed ? confirmLabel : label
  const displayedIcon = pending ? (
    <Loader2 className="size-4 animate-spin" />
  ) : armed ? (
    confirmIcon ?? icon
  ) : (
    icon
  )

  return cloneElement(render, {
    "aria-label": displayedLabel,
    children: (
      <span
        key={pending ? "pending" : armed ? "armed" : "idle"}
        className="flex min-w-0 flex-1 items-center gap-2.5 animate-in fade-in-0 slide-in-from-bottom-1 duration-150"
      >
        {displayedIcon}
        <span className="truncate">{displayedLabel}</span>
      </span>
    ),
    // Base UI menu items use this prop to decide whether selection dismisses
    // the popup. Keep it open for the first click and close on confirmation.
    closeOnClick: armed && !pending,
    disabled: disabled || pending,
    label: displayedLabel,
    onClick: (event: ReactMouseEvent<HTMLElement>) => {
      if (!armed) {
        event.preventDefault()
        setArmed(true)
        feedback.select()
        clearTimer()
        timerRef.current = setTimeout(() => setArmed(false), timeoutMs)
        return
      }

      clearTimer()
      setPending(true)
      feedback.select()
      void Promise.resolve(onConfirm()).finally(() => {
        setPending(false)
        setArmed(false)
      })
    },
  })
}

export { DoubleConfirmAction }
