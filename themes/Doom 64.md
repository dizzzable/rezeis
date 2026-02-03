npx shadcn@latest add https://shadcnthemer.com/r/themes/f5a47a0d-6db1-4c34-9103-92d6e00e8277.json

:root {
  --background: oklch(0.8452 0 0);
  --foreground: oklch(0.2393 0 0);
  --card: oklch(0.7572 0 0);
  --card-foreground: oklch(0.2393 0 0);
  --popover: oklch(0.7572 0 0);
  --popover-foreground: oklch(0.2393 0 0);
  --primary: oklch(0.5016 0.1887 27.4816);
  --primary-foreground: oklch(1.0000 0 0);
  --secondary: oklch(0.4955 0.0896 126.1858);
  --secondary-foreground: oklch(1.0000 0 0);
  --muted: oklch(0.7826 0 0);
  --muted-foreground: oklch(0.4091 0 0);
  --accent: oklch(0.5880 0.0993 245.7394);
  --accent-foreground: oklch(1.0000 0 0);
  --destructive: oklch(0.7076 0.1975 46.4558);
  --border: oklch(0.4313 0 0);
  --input: oklch(0.4313 0 0);
  --ring: oklch(0.5016 0.1887 27.4816);
  --chart-1: oklch(0.5016 0.1887 27.4816);
  --chart-2: oklch(0.4955 0.0896 126.1858);
  --chart-3: oklch(0.5880 0.0993 245.7394);
  --chart-4: oklch(0.7076 0.1975 46.4558);
  --chart-5: oklch(0.5656 0.0431 40.4319);
  --sidebar: oklch(0.7572 0 0);
  --sidebar-foreground: oklch(0.2393 0 0);
  --sidebar-primary: oklch(0.5016 0.1887 27.4816);
  --sidebar-primary-foreground: oklch(1.0000 0 0);
  --sidebar-accent: oklch(0.5880 0.0993 245.7394);
  --sidebar-accent-foreground: oklch(1.0000 0 0);
  --sidebar-border: oklch(0.4313 0 0);
  --sidebar-ring: oklch(0.5016 0.1887 27.4816);
  --font-sans: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans', sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', 'Noto Color Emoji';
  --font-serif: ui-serif, Georgia, Cambria, "Times New Roman", Times, serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  --radius: 0rem;
}

.dark {
  --background: oklch(0.2178 0 0);
  --foreground: oklch(0.9067 0 0);
  --card: oklch(0.2850 0 0);
  --card-foreground: oklch(0.9067 0 0);
  --popover: oklch(0.2850 0 0);
  --popover-foreground: oklch(0.9067 0 0);
  --primary: oklch(0.6083 0.2090 27.0276);
  --primary-foreground: oklch(1.0000 0 0);
  --secondary: oklch(0.6423 0.1467 133.0145);
  --secondary-foreground: oklch(0 0 0);
  --muted: oklch(0.2645 0 0);
  --muted-foreground: oklch(0.7058 0 0);
  --accent: oklch(0.7482 0.1235 244.7492);
  --accent-foreground: oklch(0 0 0);
  --destructive: oklch(0.7839 0.1719 68.0943);
  --border: oklch(0.4091 0 0);
  --input: oklch(0.4091 0 0);
  --ring: oklch(0.6083 0.2090 27.0276);
  --chart-1: oklch(0.6083 0.2090 27.0276);
  --chart-2: oklch(0.6423 0.1467 133.0145);
  --chart-3: oklch(0.7482 0.1235 244.7492);
  --chart-4: oklch(0.7839 0.1719 68.0943);
  --chart-5: oklch(0.6471 0.0334 40.7963);
  --sidebar: oklch(0.1913 0 0);
  --sidebar-foreground: oklch(0.9067 0 0);
  --sidebar-primary: oklch(0.6083 0.2090 27.0276);
  --sidebar-primary-foreground: oklch(1.0000 0 0);
  --sidebar-accent: oklch(0.7482 0.1235 244.7492);
  --sidebar-accent-foreground: oklch(0 0 0);
  --sidebar-border: oklch(0.4091 0 0);
  --sidebar-ring: oklch(0.6083 0.2090 27.0276);
  --font-sans: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans', sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', 'Noto Color Emoji';
  --font-serif: ui-serif, Georgia, Cambria, "Times New Roman", Times, serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  --radius: 0rem;
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