npx shadcn@latest add https://shadcnthemer.com/r/themes/824da692-dd33-48a7-8dc5-fbbdad6c2ad2.json

:root {
  --background: oklch(0.964 0.001 0);
  --foreground: oklch(0.109 0.01 144.857);
  --card: oklch(1 0.001 0);
  --card-foreground: oklch(0.109 0.01 144.857);
  --popover: oklch(1 0.001 0);
  --popover-foreground: oklch(0.109 0.01 144.857);
  --primary: oklch(0.572 0.076 159.328);
  --primary-foreground: oklch(1 0.001 0);
  --secondary: oklch(0.726 0.046 86.56);
  --secondary-foreground: oklch(0.973 0.004 91.446);
  --muted: oklch(0.855 0.008 80.719);
  --muted-foreground: oklch(0.264 0.042 82.489);
  --accent: oklch(0.949 0.005 165.005);
  --accent-foreground: oklch(0.203 0.016 195.974);
  --destructive: oklch(0.611 0.251 29.234);
  --border: oklch(0.908 0.008 80.72);
  --input: oklch(0.855 0.008 80.719);
  --ring: oklch(0.572 0.076 159.328);
  --chart-1: oklch(0.823 0.056 85.019);
  --chart-2: oklch(0.862 0.026 86.878);
  --chart-3: oklch(0.72 0.095 84.839);
  --chart-4: oklch(0.608 0.074 86.888);
  --chart-5: oklch(0.892 0.067 86.217);
  --sidebar: oklch(1 0.001 0);
  --sidebar-foreground: oklch(0.093 0.007 145.003);
  --sidebar-primary: oklch(0.572 0.076 159.328);
  --sidebar-primary-foreground: oklch(1.0000 0 0);
  --sidebar-accent: oklch(0.572 0.076 159.328);
  --sidebar-accent-foreground: oklch(1 0.001 0);
  --sidebar-border: oklch(0.908 0.008 80.72);
  --sidebar-ring: oklch(0.572 0.076 159.328);
  --font-sans: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans', sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', 'Noto Color Emoji';
  --font-serif: ui-serif, Georgia, Cambria, "Times New Roman", Times, serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  --radius: 0.625rem;
}

.dark {
  --background: oklch(0.1797 0.0043 308.1928);
  --foreground: oklch(0.8109 0 0);
  --card: oklch(0.072 0.007 18.809);
  --card-foreground: oklch(0.811 0.001 0);
  --popover: oklch(0.1797 0.0043 308.1928);
  --popover-foreground: oklch(0.8109 0 0);
  --primary: oklch(0.572 0.076 159.328);
  --primary-foreground: oklch(0.941 0.015 164.719);
  --secondary: oklch(0.357 0.049 82.576);
  --secondary-foreground: oklch(0.926 0.016 86.427);
  --muted: oklch(0.271 0.008 169.75);
  --muted-foreground: oklch(0.805 0.022 170.461);
  --accent: oklch(0.271 0.008 169.75);
  --accent-foreground: oklch(0.805 0.022 170.461);
  --destructive: oklch(0.656 0.184 15.029);
  --border: oklch(0.271 0.008 169.75);
  --input: oklch(0.444 0.019 165.96);
  --ring: oklch(0.572 0.076 159.328);
  --chart-1: oklch(0.823 0.056 85.019);
  --chart-2: oklch(0.862 0.026 86.878);
  --chart-3: oklch(0.72 0.095 84.839);
  --chart-4: oklch(0.608 0.074 86.888);
  --chart-5: oklch(0.892 0.067 86.217);
  --sidebar: oklch(0.1822 0 0);
  --sidebar-foreground: oklch(0.8109 0 0);
  --sidebar-primary: oklch(0.572 0.076 159.328);
  --sidebar-primary-foreground: oklch(0.1797 0.0043 308.1928);
  --sidebar-accent: oklch(0.3211 0 0);
  --sidebar-accent-foreground: oklch(0.8109 0 0);
  --sidebar-border: oklch(0.2520 0 0);
  --sidebar-ring: oklch(0.572 0.076 159.328);
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