npx shadcn@latest add https://shadcnthemer.com/r/themes/d7472810-4a7f-4ae1-a923-e59d4b633f5d.json

:root {
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
  --font-sans: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans', sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', 'Noto Color Emoji';
  --font-serif: ui-serif, Georgia, Cambria, "Times New Roman", Times, serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  --radius: 0.625rem;
}

.dark {
  --background: oklch(0.000 0.000 0.000);
  --foreground: oklch(0.772 0.049 89.603);
  --card: oklch(0.000 0.000 0.000);
  --card-foreground: oklch(0.581 0.104 3.550);
  --popover: oklch(0.000 0.000 0.000);
  --popover-foreground: oklch(0.772 0.049 89.603);
  --primary: oklch(0.724 0.062 31.421);
  --primary-foreground: oklch(0.000 0.000 0.000);
  --secondary: oklch(0.333 0.061 4.909);
  --secondary-foreground: oklch(0.772 0.049 89.603);
  --muted: oklch(0.000 0.000 0.000);
  --muted-foreground: oklch(0.772 0.049 89.603);
  --accent: oklch(0.421 0.077 5.549);
  --accent-foreground: oklch(0.668 0.121 5.386);
  --destructive: oklch(0.561 0.101 358.423);
  --border: oklch(0.333 0.061 4.909 / 50%);
  --input: oklch(0.000 0.000 0.000);
  --ring: oklch(0.668 0.121 5.386);
  --chart-1: oklch(0.581 0.104 3.550);
  --chart-2: oklch(0.701 0.040 56.645);
  --chart-3: oklch(0.631 0.046 23.754);
  --chart-4: oklch(0.706 0.102 8.115);
  --chart-5: oklch(0.561 0.101 358.423);
  --sidebar: oklch(0.000 0.000 0.000);
  --sidebar-foreground: oklch(0.581 0.104 3.550);
  --sidebar-primary: oklch(0.000 0.000 0.000);
  --sidebar-primary-foreground: oklch(0.772 0.049 89.603);
  --sidebar-accent: oklch(0.333 0.061 4.909);
  --sidebar-accent-foreground: oklch(0.772 0.049 89.603);
  --sidebar-border: oklch(0.421 0.077 5.549);
  --sidebar-ring: oklch(0.421 0.077 5.549);
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