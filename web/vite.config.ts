import { defineConfig } from 'vite';

/** Where `pnpm dev` sends API and WebSocket traffic. The built SPA needs no
 *  proxy at all -- the server that serves it is the same origin. */
const SERVER = process.env.CLAUDOPS_DEV_SERVER ?? 'http://127.0.0.1:8080';

export default defineConfig({
  server: {
    proxy: {
      // `ws: true` matters: without it Vite answers the terminal upgrade itself
      // and the console never connects.
      '/instances': { target: SERVER, ws: true },
      '/projects': { target: SERVER },
      '/health': { target: SERVER },
      // Without these three `pnpm dev:web` cannot log in, and every other
      // request answers 401.
      '/login': { target: SERVER },
      '/logout': { target: SERVER },
      '/session': { target: SERVER },
    },
  },
  build: {
    // Served by the Fastify server from this directory
    // (CLAUDOPS_WEB_ROOT in server/README.md).
    outDir: 'dist',
    sourcemap: true,
  },
});
