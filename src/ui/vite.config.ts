/// <reference types="vitest/config" />
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Local env lives in the repo-root `.env.local` (backend vars + the browser-safe `VITE_` vars),
 * per docs/environment-variables.md. Vite's root is `src/ui`, so by default it would look for
 * `.env.local` in `src/ui` and never find `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY`. Point
 * `envDir` at the repo root so a plain `npm run dev` / run.ps1 loads them (the e2e harness used to
 * mask this by injecting the VITE_ vars into the process environment itself).
 */
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Local dev API proxy (T-018). The API now runs as a Vercel-style function; locally it is hosted
 * either by `vercel dev` (`npm run dev:vercel`) or by the dependency-free equivalent
 * `npm run dev:api` (scripts/dev/serve-api.ts, fixed port 3001). Proxying keeps the SPA's relative
 * `/api/v1/...` calls same-origin, so no CORS configuration and no absolute API base URL are needed.
 *
 * `/api/cron` is proxied too, purely so cron endpoints can be exercised by hand against the local
 * runner during development; the SPA itself never calls them.
 */
const API_PROXY_TARGET = process.env['VITE_API_PROXY_TARGET'] ?? 'http://127.0.0.1:3001';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  envDir: REPO_ROOT,
  server: {
    proxy: {
      '/api/v1': { target: API_PROXY_TARGET, changeOrigin: true },
      '/api/cron': { target: API_PROXY_TARGET, changeOrigin: true },
    },
  },
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./src/test/setup.ts'],
  },
});
