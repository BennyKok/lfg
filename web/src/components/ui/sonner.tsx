import { useTheme } from "next-themes"
import { Toaster as Sonner, type ToasterProps } from "sonner"
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon } from "lucide-react"

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      icons={{
        success: (
          <CircleCheckIcon className="size-4" />
        ),
        info: (
          <InfoIcon className="size-4" />
        ),
        warning: (
          <TriangleAlertIcon className="size-4" />
        ),
        error: (
          <OctagonXIcon className="size-4" />
        ),
        loading: (
          <div className="size-4 animate-pulse rounded-full bg-current/20" />
        ),
      }}
      offset={{
        bottom: "var(--lfg-above-orb)",
        top: "calc(env(safe-area-inset-top) + 1rem)",
      }}
      mobileOffset={{
        bottom: "var(--lfg-above-orb)",
        // Mobile Live owns the top strip with its contextual island. Keep the
        // toast stack immediately below the measured chrome (which also grows
        // for the install/error callouts) so both surfaces stay readable.
        top: "calc(var(--lfg-mobile-header-height) + 0.5rem)",
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius-lg)",
          // Anchor width for the Sonner stack; the toast itself can shrink to
          // content via .cn-toast, capped by this value.
          "--lfg-toast-max": "min(27rem, calc(100vw - 2rem))",
          "--width": "var(--lfg-toast-max)",
          "--toast-icon-margin-end": "8px",
          fontFamily: "var(--font-sans)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast:
            "cn-toast !min-h-0 !gap-2 !rounded-xl !px-3.5 !py-2.5 !text-[13px] !leading-snug !bg-popover !text-popover-foreground !border-border font-sans",
          title: "!font-medium",
          icon: "!mx-0 !size-4 [&>svg]:!size-4",
          description: "hidden",
          success:
            "!bg-popover !text-success !border-success/30",
          error:
            "!bg-popover !text-destructive !border-destructive/30",
          actionButton:
            "cn-toast-action !h-7 !w-auto !min-w-0 !shrink-0 !rounded-lg !px-2.5 !py-0 !text-[12px] !font-medium !bg-foreground/10 !text-foreground hover:!bg-foreground/15 !transition-colors [&>svg]:!size-3.5",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
