var _a;
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
export default defineConfig({
    plugins: [react(), tailwindcss()],
    server: {
        proxy: {
            '/api': {
                target: (_a = process.env.VITE_DEV_API_PROXY_TARGET) !== null && _a !== void 0 ? _a : 'http://localhost:8100',
                changeOrigin: true,
            },
        },
    },
    resolve: {
        alias: {
            '@': path.resolve(__dirname, './src'),
        },
    },
    test: {
        environment: 'jsdom',
        globals: false,
        setupFiles: ['./src/test/setup-tests.ts'],
        css: true,
        restoreMocks: true,
        clearMocks: true,
    },
});
