import * as React from "react"
import { cn } from "@/lib/utils"

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: "default" | "success" | "warning" | "danger" | "outline"
}

function Badge({ className, variant = "default", ...props }: BadgeProps) {
  return (
    <div
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium border",
        variant === "default" && "bg-badge-bg text-badge-text border-border/70",
        variant === "success" && "bg-success/15 text-success border-success/30",
        variant === "warning" && "bg-warning/15 text-warning border-warning/30",
        variant === "danger" && "bg-danger/12 text-danger border-danger/25",
        variant === "outline" && "border border-border/70 bg-surface text-text",
        className
      )}
      {...props}
    />
  )
}

export { Badge }
