import * as React from 'react'
import * as TabsPrimitive from '@radix-ui/react-tabs'
import { cn } from '@/lib/utils'

const Tabs = TabsPrimitive.Root

/**
 * A strip allowed to wrap grows with its rows.
 *
 * `h-10` is one row's height. A caller that adds `flex-wrap` got its second and
 * third rows below the box — on a phone the admins strip wrapped to three rows
 * and the settings hub to four, drawn over the page beneath. `[&.flex-wrap]:h-auto`
 * matches only a strip that carries `flex-wrap`, and outranks `h-10` (and a
 * caller's own height) on specificity, so every wrapping strip is covered —
 * including ones this file cannot see — while a strip on one row is 40 px tall
 * either way and does not move.
 */
const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      'inline-flex h-10 items-center justify-center rounded-md bg-muted p-1 text-muted-foreground',
      '[&.flex-wrap]:h-auto',
      className,
    )}
    {...props}
  />
))
TabsList.displayName = TabsPrimitive.List.displayName

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      'inline-flex items-center justify-center whitespace-nowrap rounded-sm px-3 py-1.5 text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm',
      className,
    )}
    {...props}
  />
))
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName

/**
 * A panel's entry — a 200 ms fade and slide — is for whoever has not asked for
 * stillness.
 *
 * `motion-safe:`, as the skeleton does it: the entry exists only inside
 * `@media (prefers-reduced-motion: no-preference)`, so a system that asks to
 * reduce motion gets the panel at once. The bare `data-[state=active]:animate-in`
 * ran whatever the system said — measured in Chromium, `enter 0.2s` under
 * reduce-motion. The panel's own animations switch needs nothing here:
 * `data-animations="off"` already collapses every CSS animation app-wide.
 */
const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn(
      'mt-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
      'motion-safe:data-[state=active]:animate-in motion-safe:data-[state=active]:fade-in-0 motion-safe:data-[state=active]:slide-in-from-bottom-1 motion-safe:data-[state=active]:duration-200',
      className,
    )}
    {...props}
  />
))
TabsContent.displayName = TabsPrimitive.Content.displayName

export { Tabs, TabsList, TabsTrigger, TabsContent }
