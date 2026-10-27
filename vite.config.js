import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { localGameApi } from './dev/local-api.js';
import { csp } from './dev/csp.js';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  return {
    plugins: [
      react(),
      tailwindcss(),
      localGameApi({ enabled: !env.VITE_SUPABASE_URL }),
      // Production builds get a strict CSP. Dev is left alone: Vite's hot reload injects inline scripts.
      { name: 'csp', apply: 'build', transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: csp(env.VITE_SUPABASE_URL) }, injectTo: 'head-prepend' }] }
    ]
  };
});
