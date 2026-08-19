import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Phase 7 production-config cleanup: the backend URL the dev-server proxy
  // targets is now overridable via VITE_SERVER_URL (e.g. for a backend
  // running on a different port/host), while still defaulting to the same
  // local :3001 every previous phase has used - local dev stays a zero-config
  // `npm run dev` in both client/ and server/.
  const env = loadEnv(mode, process.cwd(), '');
  const target = env.VITE_SERVER_URL || 'http://localhost:3001';

  return {
    plugins: [react()],
    server: {
      proxy: {
        '/socket.io': { target, ws: true },
        '/api': target,
        '/uploads': target,
      },
    },
  };
})
