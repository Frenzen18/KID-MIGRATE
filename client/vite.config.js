import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Security: this is an authenticated portal app — protected pages must never
// be served from the browser's back/forward cache (bfcache) or disk cache,
// or a logged-out user could see a frozen snapshot of the portal by hitting
// the Back button. `Cache-Control: no-store` on the HTML response is the
// authoritative fix (stronger than the <meta> tag, which some browsers ignore).
function noStoreHtml() {
  return {
    name: 'no-store-html',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        next();
      });
    }
  };
}

export default defineConfig({
  plugins: [react(), noStoreHtml()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:4000'
    }
  }
});
