import { cn } from '@/lib/utils'

/**
 * A placeholder block that shimmers while its content loads — for whoever has
 * not asked for stillness.
 *
 * `motion-safe:`, not a bare `animate-pulse`: the bare one pulsed for an
 * operator whose system asks to reduce motion, since nothing in `index.css`
 * stops Tailwind's pulse under `prefers-reduced-motion`. The panel's own
 * animations switch needs nothing here — `data-animations="off"` already
 * collapses every CSS animation app-wide.
 */
function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('rounded-md bg-muted motion-safe:animate-pulse', className)}
      {...props}
    />
  )
}

export { Skeleton }
