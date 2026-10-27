import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { devApi } from './server/devApi.js';

// - react(): React fast refresh.
// - devApi(): during `vite dev`, serves /api/* from web/api/*.js (the same files Vercel deploys).
// - envDir '..': .env lives in the repo root. Only VITE_* variables are ever exposed to the
//   browser; server-side secrets (TOKEN_FACTORY_API_KEY...) are read by web/api only.
export default defineConfig({
  plugins: [react(), devApi()],
  envDir: '..',
});
