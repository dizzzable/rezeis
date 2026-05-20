/**
 * Curated theme presets compatible with shadcn/ui 2024 OKLCH variables.
 *
 * Each preset stores the full `:root { … } .dark { … }` block as a raw
 * CSS string — exactly the format produced by:
 *   • https://ui.shadcn.com/themes
 *   • https://shadcnthemer.com
 *   • https://tweakcn.com
 *
 * They get injected verbatim through the same `<style>` element the
 * "Paste a theme" UI uses, so the runtime path is identical for both
 * curated presets and operator-supplied themes.
 */

export interface ThemePreset {
  /** Stable id stored in the theme store. */
  id: string
  /** Display name on the preset card. */
  name: string
  /** Short blurb shown under the name. */
  description: string
  /** Color used for the swatch chip in the preset gallery (any CSS color). */
  swatch: string
  /** Full `:root { … } .dark { … }` block. */
  css: string
}

// ── Default — shadcn 2024 neutral ────────────────────────────────────────────
const DEFAULT_CSS = `:root {
  --background: oklch(1 0 0);
  --foreground: oklch(0.145 0 0);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.145 0 0);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0.145 0 0);
  --primary: oklch(0.205 0 0);
  --primary-foreground: oklch(0.985 0 0);
  --secondary: oklch(0.97 0 0);
  --secondary-foreground: oklch(0.205 0 0);
  --muted: oklch(0.97 0 0);
  --muted-foreground: oklch(0.556 0 0);
  --accent: oklch(0.97 0 0);
  --accent-foreground: oklch(0.205 0 0);
  --destructive: oklch(0.577 0.245 27.325);
  --destructive-foreground: oklch(0.985 0 0);
  --border: oklch(0.922 0 0);
  --input: oklch(0.922 0 0);
  --ring: oklch(0.708 0 0);
  --chart-1: oklch(0.646 0.222 41.116);
  --chart-2: oklch(0.6 0.118 184.704);
  --chart-3: oklch(0.398 0.07 227.392);
  --chart-4: oklch(0.828 0.189 84.429);
  --chart-5: oklch(0.769 0.188 70.08);
  --sidebar: oklch(0.985 0 0);
  --sidebar-foreground: oklch(0.145 0 0);
  --sidebar-primary: oklch(0.205 0 0);
  --sidebar-primary-foreground: oklch(0.985 0 0);
  --sidebar-accent: oklch(0.97 0 0);
  --sidebar-accent-foreground: oklch(0.205 0 0);
  --sidebar-border: oklch(0.922 0 0);
  --sidebar-ring: oklch(0.708 0 0);
}
.dark {
  --background: oklch(0.145 0 0);
  --foreground: oklch(0.985 0 0);
  --card: oklch(0.205 0 0);
  --card-foreground: oklch(0.985 0 0);
  --popover: oklch(0.205 0 0);
  --popover-foreground: oklch(0.985 0 0);
  --primary: oklch(0.922 0 0);
  --primary-foreground: oklch(0.205 0 0);
  --secondary: oklch(0.269 0 0);
  --secondary-foreground: oklch(0.985 0 0);
  --muted: oklch(0.269 0 0);
  --muted-foreground: oklch(0.708 0 0);
  --accent: oklch(0.269 0 0);
  --accent-foreground: oklch(0.985 0 0);
  --destructive: oklch(0.704 0.191 22.216);
  --destructive-foreground: oklch(0.985 0 0);
  --border: oklch(1 0 0 / 10%);
  --input: oklch(1 0 0 / 15%);
  --ring: oklch(0.556 0 0);
  --chart-1: oklch(0.488 0.243 264.376);
  --chart-2: oklch(0.696 0.17 162.48);
  --chart-3: oklch(0.769 0.188 70.08);
  --chart-4: oklch(0.627 0.265 303.9);
  --chart-5: oklch(0.645 0.246 16.439);
  --sidebar: oklch(0.205 0 0);
  --sidebar-foreground: oklch(0.985 0 0);
  --sidebar-primary: oklch(0.488 0.243 264.376);
  --sidebar-primary-foreground: oklch(0.985 0 0);
  --sidebar-accent: oklch(0.269 0 0);
  --sidebar-accent-foreground: oklch(0.985 0 0);
  --sidebar-border: oklch(1 0 0 / 10%);
  --sidebar-ring: oklch(0.556 0 0);
}`

// ── Mono — pure black/white from shadcnthemer ────────────────────────────────
const MONO_CSS = `:root {
  --background: oklch(0.99 0 0);
  --foreground: oklch(0 0 0);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0 0 0);
  --popover: oklch(0.99 0 0);
  --popover-foreground: oklch(0 0 0);
  --primary: oklch(0 0 0);
  --primary-foreground: oklch(1 0 0);
  --secondary: oklch(0.94 0 0);
  --secondary-foreground: oklch(0 0 0);
  --muted: oklch(0.97 0 0);
  --muted-foreground: oklch(0.44 0 0);
  --accent: oklch(0.94 0 0);
  --accent-foreground: oklch(0 0 0);
  --destructive: oklch(0.63 0.19 23.03);
  --destructive-foreground: oklch(0.985 0 0);
  --border: oklch(0.92 0 0);
  --input: oklch(0.94 0 0);
  --ring: oklch(0 0 0);
  --chart-1: oklch(0.81 0.17 75.35);
  --chart-2: oklch(0.55 0.22 264.53);
  --chart-3: oklch(0.72 0 0);
  --chart-4: oklch(0.92 0 0);
  --chart-5: oklch(0.56 0 0);
  --sidebar: oklch(0.99 0 0);
  --sidebar-foreground: oklch(0 0 0);
  --sidebar-primary: oklch(0 0 0);
  --sidebar-primary-foreground: oklch(1 0 0);
  --sidebar-accent: oklch(0.94 0 0);
  --sidebar-accent-foreground: oklch(0 0 0);
  --sidebar-border: oklch(0.94 0 0);
  --sidebar-ring: oklch(0 0 0);
}
.dark {
  --background: oklch(0 0 0);
  --foreground: oklch(1 0 0);
  --card: oklch(0.14 0 0);
  --card-foreground: oklch(1 0 0);
  --popover: oklch(0.18 0 0);
  --popover-foreground: oklch(1 0 0);
  --primary: oklch(1 0 0);
  --primary-foreground: oklch(0 0 0);
  --secondary: oklch(0.25 0 0);
  --secondary-foreground: oklch(1 0 0);
  --muted: oklch(0.23 0 0);
  --muted-foreground: oklch(0.72 0 0);
  --accent: oklch(0.32 0 0);
  --accent-foreground: oklch(1 0 0);
  --destructive: oklch(0.69 0.20 23.91);
  --destructive-foreground: oklch(0.985 0 0);
  --border: oklch(0.26 0 0);
  --input: oklch(0.32 0 0);
  --ring: oklch(0.72 0 0);
  --chart-1: oklch(0.81 0.17 75.35);
  --chart-2: oklch(0.58 0.21 260.84);
  --chart-3: oklch(0.56 0 0);
  --chart-4: oklch(0.44 0 0);
  --chart-5: oklch(0.92 0 0);
  --sidebar: oklch(0.18 0 0);
  --sidebar-foreground: oklch(1 0 0);
  --sidebar-primary: oklch(1 0 0);
  --sidebar-primary-foreground: oklch(0 0 0);
  --sidebar-accent: oklch(0.32 0 0);
  --sidebar-accent-foreground: oklch(1 0 0);
  --sidebar-border: oklch(0.32 0 0);
  --sidebar-ring: oklch(0.72 0 0);
}`

// ── Blue — shadcn blue base color ────────────────────────────────────────────
const BLUE_CSS = `:root {
  --background: oklch(1 0 0);
  --foreground: oklch(0.13 0.028 261.692);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.13 0.028 261.692);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0.13 0.028 261.692);
  --primary: oklch(0.546 0.245 262.881);
  --primary-foreground: oklch(0.984 0.018 246.232);
  --secondary: oklch(0.967 0.003 264.542);
  --secondary-foreground: oklch(0.21 0.034 264.665);
  --muted: oklch(0.967 0.003 264.542);
  --muted-foreground: oklch(0.551 0.027 264.364);
  --accent: oklch(0.967 0.003 264.542);
  --accent-foreground: oklch(0.21 0.034 264.665);
  --destructive: oklch(0.577 0.245 27.325);
  --destructive-foreground: oklch(0.984 0.018 246.232);
  --border: oklch(0.928 0.006 264.531);
  --input: oklch(0.928 0.006 264.531);
  --ring: oklch(0.546 0.245 262.881);
  --chart-1: oklch(0.546 0.245 262.881);
  --chart-2: oklch(0.6 0.118 184.704);
  --chart-3: oklch(0.398 0.07 227.392);
  --chart-4: oklch(0.828 0.189 84.429);
  --chart-5: oklch(0.769 0.188 70.08);
  --sidebar: oklch(0.984 0.003 247.858);
  --sidebar-foreground: oklch(0.13 0.028 261.692);
  --sidebar-primary: oklch(0.546 0.245 262.881);
  --sidebar-primary-foreground: oklch(0.984 0.018 246.232);
  --sidebar-accent: oklch(0.967 0.003 264.542);
  --sidebar-accent-foreground: oklch(0.21 0.034 264.665);
  --sidebar-border: oklch(0.928 0.006 264.531);
  --sidebar-ring: oklch(0.546 0.245 262.881);
}
.dark {
  --background: oklch(0.13 0.028 261.692);
  --foreground: oklch(0.984 0.003 247.858);
  --card: oklch(0.21 0.034 264.665);
  --card-foreground: oklch(0.984 0.003 247.858);
  --popover: oklch(0.21 0.034 264.665);
  --popover-foreground: oklch(0.984 0.003 247.858);
  --primary: oklch(0.623 0.214 259.815);
  --primary-foreground: oklch(0.984 0.018 246.232);
  --secondary: oklch(0.278 0.033 256.848);
  --secondary-foreground: oklch(0.984 0.003 247.858);
  --muted: oklch(0.278 0.033 256.848);
  --muted-foreground: oklch(0.707 0.022 261.325);
  --accent: oklch(0.278 0.033 256.848);
  --accent-foreground: oklch(0.984 0.003 247.858);
  --destructive: oklch(0.704 0.191 22.216);
  --destructive-foreground: oklch(0.984 0.018 246.232);
  --border: oklch(1 0 0 / 10%);
  --input: oklch(1 0 0 / 15%);
  --ring: oklch(0.623 0.214 259.815);
  --chart-1: oklch(0.488 0.243 264.376);
  --chart-2: oklch(0.696 0.17 162.48);
  --chart-3: oklch(0.769 0.188 70.08);
  --chart-4: oklch(0.627 0.265 303.9);
  --chart-5: oklch(0.645 0.246 16.439);
  --sidebar: oklch(0.21 0.034 264.665);
  --sidebar-foreground: oklch(0.984 0.003 247.858);
  --sidebar-primary: oklch(0.623 0.214 259.815);
  --sidebar-primary-foreground: oklch(0.984 0.018 246.232);
  --sidebar-accent: oklch(0.278 0.033 256.848);
  --sidebar-accent-foreground: oklch(0.984 0.003 247.858);
  --sidebar-border: oklch(1 0 0 / 10%);
  --sidebar-ring: oklch(0.623 0.214 259.815);
}`

// ── Green — shadcn green base color ──────────────────────────────────────────
const GREEN_CSS = `:root {
  --background: oklch(1 0 0);
  --foreground: oklch(0.145 0 0);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.145 0 0);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0.145 0 0);
  --primary: oklch(0.696 0.17 162.48);
  --primary-foreground: oklch(0.13 0.028 261.692);
  --secondary: oklch(0.97 0 0);
  --secondary-foreground: oklch(0.205 0 0);
  --muted: oklch(0.97 0 0);
  --muted-foreground: oklch(0.556 0 0);
  --accent: oklch(0.97 0 0);
  --accent-foreground: oklch(0.205 0 0);
  --destructive: oklch(0.577 0.245 27.325);
  --destructive-foreground: oklch(0.985 0 0);
  --border: oklch(0.922 0 0);
  --input: oklch(0.922 0 0);
  --ring: oklch(0.696 0.17 162.48);
  --chart-1: oklch(0.696 0.17 162.48);
  --chart-2: oklch(0.6 0.118 184.704);
  --chart-3: oklch(0.398 0.07 227.392);
  --chart-4: oklch(0.828 0.189 84.429);
  --chart-5: oklch(0.769 0.188 70.08);
  --sidebar: oklch(0.985 0 0);
  --sidebar-foreground: oklch(0.145 0 0);
  --sidebar-primary: oklch(0.696 0.17 162.48);
  --sidebar-primary-foreground: oklch(0.13 0.028 261.692);
  --sidebar-accent: oklch(0.97 0 0);
  --sidebar-accent-foreground: oklch(0.205 0 0);
  --sidebar-border: oklch(0.922 0 0);
  --sidebar-ring: oklch(0.696 0.17 162.48);
}
.dark {
  --background: oklch(0.145 0 0);
  --foreground: oklch(0.985 0 0);
  --card: oklch(0.205 0 0);
  --card-foreground: oklch(0.985 0 0);
  --popover: oklch(0.205 0 0);
  --popover-foreground: oklch(0.985 0 0);
  --primary: oklch(0.696 0.17 162.48);
  --primary-foreground: oklch(0.13 0.028 261.692);
  --secondary: oklch(0.269 0 0);
  --secondary-foreground: oklch(0.985 0 0);
  --muted: oklch(0.269 0 0);
  --muted-foreground: oklch(0.708 0 0);
  --accent: oklch(0.269 0 0);
  --accent-foreground: oklch(0.985 0 0);
  --destructive: oklch(0.704 0.191 22.216);
  --destructive-foreground: oklch(0.985 0 0);
  --border: oklch(1 0 0 / 10%);
  --input: oklch(1 0 0 / 15%);
  --ring: oklch(0.696 0.17 162.48);
  --chart-1: oklch(0.696 0.17 162.48);
  --chart-2: oklch(0.6 0.118 184.704);
  --chart-3: oklch(0.769 0.188 70.08);
  --chart-4: oklch(0.627 0.265 303.9);
  --chart-5: oklch(0.645 0.246 16.439);
  --sidebar: oklch(0.205 0 0);
  --sidebar-foreground: oklch(0.985 0 0);
  --sidebar-primary: oklch(0.696 0.17 162.48);
  --sidebar-primary-foreground: oklch(0.13 0.028 261.692);
  --sidebar-accent: oklch(0.269 0 0);
  --sidebar-accent-foreground: oklch(0.985 0 0);
  --sidebar-border: oklch(1 0 0 / 10%);
  --sidebar-ring: oklch(0.696 0.17 162.48);
}`

// ── Rose — shadcn rose base color ────────────────────────────────────────────
const ROSE_CSS = `:root {
  --background: oklch(1 0 0);
  --foreground: oklch(0.13 0.028 261.692);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.13 0.028 261.692);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0.13 0.028 261.692);
  --primary: oklch(0.645 0.246 16.439);
  --primary-foreground: oklch(0.984 0.018 246.232);
  --secondary: oklch(0.967 0.003 264.542);
  --secondary-foreground: oklch(0.21 0.034 264.665);
  --muted: oklch(0.967 0.003 264.542);
  --muted-foreground: oklch(0.551 0.027 264.364);
  --accent: oklch(0.967 0.003 264.542);
  --accent-foreground: oklch(0.21 0.034 264.665);
  --destructive: oklch(0.577 0.245 27.325);
  --destructive-foreground: oklch(0.984 0.018 246.232);
  --border: oklch(0.928 0.006 264.531);
  --input: oklch(0.928 0.006 264.531);
  --ring: oklch(0.645 0.246 16.439);
  --chart-1: oklch(0.645 0.246 16.439);
  --chart-2: oklch(0.6 0.118 184.704);
  --chart-3: oklch(0.398 0.07 227.392);
  --chart-4: oklch(0.828 0.189 84.429);
  --chart-5: oklch(0.769 0.188 70.08);
  --sidebar: oklch(0.984 0.003 247.858);
  --sidebar-foreground: oklch(0.13 0.028 261.692);
  --sidebar-primary: oklch(0.645 0.246 16.439);
  --sidebar-primary-foreground: oklch(0.984 0.018 246.232);
  --sidebar-accent: oklch(0.967 0.003 264.542);
  --sidebar-accent-foreground: oklch(0.21 0.034 264.665);
  --sidebar-border: oklch(0.928 0.006 264.531);
  --sidebar-ring: oklch(0.645 0.246 16.439);
}
.dark {
  --background: oklch(0.13 0.028 261.692);
  --foreground: oklch(0.984 0.003 247.858);
  --card: oklch(0.21 0.034 264.665);
  --card-foreground: oklch(0.984 0.003 247.858);
  --popover: oklch(0.21 0.034 264.665);
  --popover-foreground: oklch(0.984 0.003 247.858);
  --primary: oklch(0.645 0.246 16.439);
  --primary-foreground: oklch(0.984 0.018 246.232);
  --secondary: oklch(0.278 0.033 256.848);
  --secondary-foreground: oklch(0.984 0.003 247.858);
  --muted: oklch(0.278 0.033 256.848);
  --muted-foreground: oklch(0.707 0.022 261.325);
  --accent: oklch(0.278 0.033 256.848);
  --accent-foreground: oklch(0.984 0.003 247.858);
  --destructive: oklch(0.704 0.191 22.216);
  --destructive-foreground: oklch(0.984 0.018 246.232);
  --border: oklch(1 0 0 / 10%);
  --input: oklch(1 0 0 / 15%);
  --ring: oklch(0.645 0.246 16.439);
  --chart-1: oklch(0.645 0.246 16.439);
  --chart-2: oklch(0.696 0.17 162.48);
  --chart-3: oklch(0.769 0.188 70.08);
  --chart-4: oklch(0.627 0.265 303.9);
  --chart-5: oklch(0.488 0.243 264.376);
  --sidebar: oklch(0.21 0.034 264.665);
  --sidebar-foreground: oklch(0.984 0.003 247.858);
  --sidebar-primary: oklch(0.645 0.246 16.439);
  --sidebar-primary-foreground: oklch(0.984 0.018 246.232);
  --sidebar-accent: oklch(0.278 0.033 256.848);
  --sidebar-accent-foreground: oklch(0.984 0.003 247.858);
  --sidebar-border: oklch(1 0 0 / 10%);
  --sidebar-ring: oklch(0.645 0.246 16.439);
}`

// ── Violet — shadcn violet base color ────────────────────────────────────────
const VIOLET_CSS = `:root {
  --background: oklch(1 0 0);
  --foreground: oklch(0.13 0.028 261.692);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.13 0.028 261.692);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0.13 0.028 261.692);
  --primary: oklch(0.541 0.281 293.009);
  --primary-foreground: oklch(0.984 0.018 246.232);
  --secondary: oklch(0.967 0.003 264.542);
  --secondary-foreground: oklch(0.21 0.034 264.665);
  --muted: oklch(0.967 0.003 264.542);
  --muted-foreground: oklch(0.551 0.027 264.364);
  --accent: oklch(0.967 0.003 264.542);
  --accent-foreground: oklch(0.21 0.034 264.665);
  --destructive: oklch(0.577 0.245 27.325);
  --destructive-foreground: oklch(0.984 0.018 246.232);
  --border: oklch(0.928 0.006 264.531);
  --input: oklch(0.928 0.006 264.531);
  --ring: oklch(0.541 0.281 293.009);
  --chart-1: oklch(0.541 0.281 293.009);
  --chart-2: oklch(0.6 0.118 184.704);
  --chart-3: oklch(0.398 0.07 227.392);
  --chart-4: oklch(0.828 0.189 84.429);
  --chart-5: oklch(0.769 0.188 70.08);
  --sidebar: oklch(0.984 0.003 247.858);
  --sidebar-foreground: oklch(0.13 0.028 261.692);
  --sidebar-primary: oklch(0.541 0.281 293.009);
  --sidebar-primary-foreground: oklch(0.984 0.018 246.232);
  --sidebar-accent: oklch(0.967 0.003 264.542);
  --sidebar-accent-foreground: oklch(0.21 0.034 264.665);
  --sidebar-border: oklch(0.928 0.006 264.531);
  --sidebar-ring: oklch(0.541 0.281 293.009);
}
.dark {
  --background: oklch(0.13 0.028 261.692);
  --foreground: oklch(0.984 0.003 247.858);
  --card: oklch(0.21 0.034 264.665);
  --card-foreground: oklch(0.984 0.003 247.858);
  --popover: oklch(0.21 0.034 264.665);
  --popover-foreground: oklch(0.984 0.003 247.858);
  --primary: oklch(0.541 0.281 293.009);
  --primary-foreground: oklch(0.984 0.018 246.232);
  --secondary: oklch(0.278 0.033 256.848);
  --secondary-foreground: oklch(0.984 0.003 247.858);
  --muted: oklch(0.278 0.033 256.848);
  --muted-foreground: oklch(0.707 0.022 261.325);
  --accent: oklch(0.278 0.033 256.848);
  --accent-foreground: oklch(0.984 0.003 247.858);
  --destructive: oklch(0.704 0.191 22.216);
  --destructive-foreground: oklch(0.984 0.018 246.232);
  --border: oklch(1 0 0 / 10%);
  --input: oklch(1 0 0 / 15%);
  --ring: oklch(0.541 0.281 293.009);
  --chart-1: oklch(0.541 0.281 293.009);
  --chart-2: oklch(0.696 0.17 162.48);
  --chart-3: oklch(0.769 0.188 70.08);
  --chart-4: oklch(0.627 0.265 303.9);
  --chart-5: oklch(0.645 0.246 16.439);
  --sidebar: oklch(0.21 0.034 264.665);
  --sidebar-foreground: oklch(0.984 0.003 247.858);
  --sidebar-primary: oklch(0.541 0.281 293.009);
  --sidebar-primary-foreground: oklch(0.984 0.018 246.232);
  --sidebar-accent: oklch(0.278 0.033 256.848);
  --sidebar-accent-foreground: oklch(0.984 0.003 247.858);
  --sidebar-border: oklch(1 0 0 / 10%);
  --sidebar-ring: oklch(0.541 0.281 293.009);
}`

// ── Orange — shadcn orange base color ────────────────────────────────────────
const ORANGE_CSS = `:root {
  --background: oklch(1 0 0);
  --foreground: oklch(0.145 0 0);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.145 0 0);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0.145 0 0);
  --primary: oklch(0.646 0.222 41.116);
  --primary-foreground: oklch(0.985 0 0);
  --secondary: oklch(0.97 0 0);
  --secondary-foreground: oklch(0.205 0 0);
  --muted: oklch(0.97 0 0);
  --muted-foreground: oklch(0.556 0 0);
  --accent: oklch(0.97 0 0);
  --accent-foreground: oklch(0.205 0 0);
  --destructive: oklch(0.577 0.245 27.325);
  --destructive-foreground: oklch(0.985 0 0);
  --border: oklch(0.922 0 0);
  --input: oklch(0.922 0 0);
  --ring: oklch(0.646 0.222 41.116);
  --chart-1: oklch(0.646 0.222 41.116);
  --chart-2: oklch(0.6 0.118 184.704);
  --chart-3: oklch(0.398 0.07 227.392);
  --chart-4: oklch(0.828 0.189 84.429);
  --chart-5: oklch(0.769 0.188 70.08);
  --sidebar: oklch(0.985 0 0);
  --sidebar-foreground: oklch(0.145 0 0);
  --sidebar-primary: oklch(0.646 0.222 41.116);
  --sidebar-primary-foreground: oklch(0.985 0 0);
  --sidebar-accent: oklch(0.97 0 0);
  --sidebar-accent-foreground: oklch(0.205 0 0);
  --sidebar-border: oklch(0.922 0 0);
  --sidebar-ring: oklch(0.646 0.222 41.116);
}
.dark {
  --background: oklch(0.145 0 0);
  --foreground: oklch(0.985 0 0);
  --card: oklch(0.205 0 0);
  --card-foreground: oklch(0.985 0 0);
  --popover: oklch(0.205 0 0);
  --popover-foreground: oklch(0.985 0 0);
  --primary: oklch(0.646 0.222 41.116);
  --primary-foreground: oklch(0.985 0 0);
  --secondary: oklch(0.269 0 0);
  --secondary-foreground: oklch(0.985 0 0);
  --muted: oklch(0.269 0 0);
  --muted-foreground: oklch(0.708 0 0);
  --accent: oklch(0.269 0 0);
  --accent-foreground: oklch(0.985 0 0);
  --destructive: oklch(0.704 0.191 22.216);
  --destructive-foreground: oklch(0.985 0 0);
  --border: oklch(1 0 0 / 10%);
  --input: oklch(1 0 0 / 15%);
  --ring: oklch(0.646 0.222 41.116);
  --chart-1: oklch(0.646 0.222 41.116);
  --chart-2: oklch(0.696 0.17 162.48);
  --chart-3: oklch(0.769 0.188 70.08);
  --chart-4: oklch(0.627 0.265 303.9);
  --chart-5: oklch(0.645 0.246 16.439);
  --sidebar: oklch(0.205 0 0);
  --sidebar-foreground: oklch(0.985 0 0);
  --sidebar-primary: oklch(0.646 0.222 41.116);
  --sidebar-primary-foreground: oklch(0.985 0 0);
  --sidebar-accent: oklch(0.269 0 0);
  --sidebar-accent-foreground: oklch(0.985 0 0);
  --sidebar-border: oklch(1 0 0 / 10%);
  --sidebar-ring: oklch(0.646 0.222 41.116);
}`

export const THEME_PRESETS: ThemePreset[] = [
  {
    id: 'default',
    name: 'Neutral',
    description: 'shadcn 2024 base — neutral grayscale',
    swatch: 'oklch(0.205 0 0)',
    css: DEFAULT_CSS,
  },
  {
    id: 'mono',
    name: 'Mono',
    description: 'Pure black & white from shadcnthemer',
    swatch: 'oklch(0 0 0)',
    css: MONO_CSS,
  },
  {
    id: 'blue',
    name: 'Blue',
    description: 'Cool blue accent',
    swatch: 'oklch(0.546 0.245 262.881)',
    css: BLUE_CSS,
  },
  {
    id: 'violet',
    name: 'Violet',
    description: 'Royal violet accent',
    swatch: 'oklch(0.541 0.281 293.009)',
    css: VIOLET_CSS,
  },
  {
    id: 'green',
    name: 'Green',
    description: 'Mint green accent',
    swatch: 'oklch(0.696 0.17 162.48)',
    css: GREEN_CSS,
  },
  {
    id: 'orange',
    name: 'Orange',
    description: 'Warm sunset orange',
    swatch: 'oklch(0.646 0.222 41.116)',
    css: ORANGE_CSS,
  },
  {
    id: 'rose',
    name: 'Rose',
    description: 'Vibrant pink accent',
    swatch: 'oklch(0.645 0.246 16.439)',
    css: ROSE_CSS,
  },
]

export const PRESET_BY_ID: Record<string, ThemePreset> = Object.fromEntries(
  THEME_PRESETS.map((preset) => [preset.id, preset]),
)

export function getPresetCss(id: string): string {
  return PRESET_BY_ID[id]?.css ?? ''
}
