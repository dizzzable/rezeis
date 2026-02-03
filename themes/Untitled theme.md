npx shadcn@latest add https://shadcnthemer.com/r/themes/d3180a4f-7393-4b68-bdea-f49e971454c7.json

:root {
  --background: var(--base-50);
  --foreground: var(--base-800);
  --card: var(--color-white);
  --card-foreground: var(--base-800);
  --popover: var(--color-white);
  --popover-foreground: var(--base-800);
  --primary: var(--primary-300);
  --primary-foreground: var(--color-black);
  --secondary: var(--secondary-400);
  --secondary-foreground: var(--color-black);
  --muted: var(--base-100);
  --muted-foreground: var(--base-600);
  --accent: var(--base-100);
  --accent-foreground: var(--base-800);
  --destructive: oklch(0.577 0.245 27.325);
  --border: var(--base-200);
  --input: var(--base-300);
  --ring: var(--primary-300);
  --chart-1: var(--primary-300);
  --chart-2: var(--secondary-400);
  --chart-3: var(--primary-400);
  --chart-4: var(--secondary-300);
  --chart-5: var(--primary-300);
  --sidebar: var(--color-white);
  --sidebar-foreground: var(--base-800);
  --sidebar-primary: var(--primary-300);
  --sidebar-primary-foreground: var(--color-black);
  --sidebar-accent: var(--base-50);
  --sidebar-accent-foreground: var(--base-800);
  --sidebar-border: var(--base-200);
  --sidebar-ring: var(--primary-300);
  --font-sans: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans', sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', 'Noto Color Emoji';
  --font-serif: ui-serif, Georgia, Cambria, "Times New Roman", Times, serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  --radius: 0.625rem;
}

.dark {
  --background: var(--base-950);
  --foreground: var(--base-200);
  --card: var(--base-900);
  --card-foreground: var(--base-200);
  --popover: var(--base-900);
  --popover-foreground: var(--base-200);
  --primary: var(--primary-300);
  --primary-foreground: var(--color-black);
  --secondary: var(--secondary-400);
  --secondary-foreground: var(--color-black);
  --muted: var(--base-800);
  --muted-foreground: var(--base-300);
  --accent: var(--base-800);
  --accent-foreground: var(--base-200);
  --destructive: oklch(0.704 0.191 22.216);
  --border: var(--base-800);
  --input: var(--base-700);
  --ring: var(--primary-300);
  --chart-1: var(--primary-300);
  --chart-2: var(--secondary-400);
  --chart-3: var(--primary-400);
  --chart-4: var(--secondary-300);
  --chart-5: var(--primary-300);
  --sidebar: var(--base-900);
  --sidebar-foreground: var(--base-200);
  --sidebar-primary: var(--primary-300);
  --sidebar-primary-foreground: var(--color-black);
  --sidebar-accent: var(--base-800);
  --sidebar-accent-foreground: var(--base-200);
  --sidebar-border: var(--base-800);
  --sidebar-ring: var(--primary-300);
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