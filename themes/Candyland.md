npx shadcn@latest add https://shadcnthemer.com/r/themes/26f36512-7e14-406f-87e5-9b3355ac06e8.json

:root {
  --background: oklch(0.9809 0.0025 228.7836);
  --foreground: oklch(0.3211 0 0);
  --card: oklch(1.0000 0 0);
  --card-foreground: oklch(0.3211 0 0);
  --popover: oklch(1.0000 0 0);
  --popover-foreground: oklch(0.3211 0 0);
  --primary: oklch(0.8677 0.0735 7.0855);
  --primary-foreground: oklch(0 0 0);
  --secondary: oklch(0.8148 0.0819 225.7537);
  --secondary-foreground: oklch(0 0 0);
  --muted: oklch(0.8828 0.0285 98.1033);
  --muted-foreground: oklch(0.5382 0 0);
  --accent: oklch(0.9680 0.2110 109.7692);
  --accent-foreground: oklch(0 0 0);
  --destructive: oklch(0.6368 0.2078 25.3313);
  --border: oklch(0.8699 0 0);
  --input: oklch(0.8699 0 0);
  --ring: oklch(0.8677 0.0735 7.0855);
  --chart-1: oklch(0.8677 0.0735 7.0855);
  --chart-2: oklch(0.8148 0.0819 225.7537);
  --chart-3: oklch(0.9680 0.2110 109.7692);
  --chart-4: oklch(0.8027 0.1355 349.2347);
  --chart-5: oklch(0.7395 0.2268 142.8504);
  --sidebar: oklch(0.9809 0.0025 228.7836);
  --sidebar-foreground: oklch(0.3211 0 0);
  --sidebar-primary: oklch(0.8677 0.0735 7.0855);
  --sidebar-primary-foreground: oklch(0 0 0);
  --sidebar-accent: oklch(0.9680 0.2110 109.7692);
  --sidebar-accent-foreground: oklch(0 0 0);
  --sidebar-border: oklch(0.8699 0 0);
  --sidebar-ring: oklch(0.8677 0.0735 7.0855);
  --font-sans: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans', sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', 'Noto Color Emoji';
  --font-serif: ui-serif, Georgia, Cambria, "Times New Roman", Times, serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  --radius: 0.625rem;
}

.dark {
  --background: oklch(0.2303 0.0125 264.2926);
  --foreground: oklch(0.9219 0 0);
  --card: oklch(0.3210 0.0078 223.6661);
  --card-foreground: oklch(0.9219 0 0);
  --popover: oklch(0.3210 0.0078 223.6661);
  --popover-foreground: oklch(0.9219 0 0);
  --primary: oklch(0.8027 0.1355 349.2347);
  --primary-foreground: oklch(0 0 0);
  --secondary: oklch(0.7395 0.2268 142.8504);
  --secondary-foreground: oklch(0 0 0);
  --muted: oklch(0.3867 0 0);
  --muted-foreground: oklch(0.7155 0 0);
  --accent: oklch(0.8148 0.0819 225.7537);
  --accent-foreground: oklch(0 0 0);
  --destructive: oklch(0.6368 0.2078 25.3313);
  --border: oklch(0.3867 0 0);
  --input: oklch(0.3867 0 0);
  --ring: oklch(0.8027 0.1355 349.2347);
  --chart-1: oklch(0.8027 0.1355 349.2347);
  --chart-2: oklch(0.7395 0.2268 142.8504);
  --chart-3: oklch(0.8148 0.0819 225.7537);
  --chart-4: oklch(0.9680 0.2110 109.7692);
  --chart-5: oklch(0.8652 0.1768 90.3816);
  --sidebar: oklch(0.2303 0.0125 264.2926);
  --sidebar-foreground: oklch(0.9219 0 0);
  --sidebar-primary: oklch(0.8027 0.1355 349.2347);
  --sidebar-primary-foreground: oklch(0 0 0);
  --sidebar-accent: oklch(0.8148 0.0819 225.7537);
  --sidebar-accent-foreground: oklch(0 0 0);
  --sidebar-border: oklch(0.3867 0 0);
  --sidebar-ring: oklch(0.8027 0.1355 349.2347);
  --font-sans: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans', sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', 'Noto Color Emoji';
  --font-serif: ui-serif, Georgia, Cambria, "Times New Roman", Times, serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  --radius: 0.625rem;
}

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --color-chart-1: var(--chart-1);
  --color-chart-2: var(--chart-2);
  --color-chart-3: var(--chart-3);
  --color-chart-4: var(--chart-4);
  --color-chart-5: var(--chart-5);
  --color-sidebar: var(--sidebar);
  --color-sidebar-foreground: var(--sidebar-foreground);
  --color-sidebar-primary: var(--sidebar-primary);
  --color-sidebar-primary-foreground: var(--sidebar-primary-foreground);
  --color-sidebar-accent: var(--sidebar-accent);
  --color-sidebar-accent-foreground: var(--sidebar-accent-foreground);
  --color-sidebar-border: var(--sidebar-border);
  --color-sidebar-ring: var(--sidebar-ring);

  --font-sans: var(--font-sans);
  --font-mono: var(--font-mono);
  --font-serif: var(--font-serif);

  --radius-sm: calc(var(--radius) - 4px);
  --radius-md: calc(var(--radius) - 2px);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) + 4px);
}