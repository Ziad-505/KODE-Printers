import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * Build configuration.
 *
 * The output lands in `apps/server/public`, which `app.ts` serves statically
 * behind the same origin as the API. Same-origin is what lets the CSP stay at
 * `connect-src 'self'` and the refresh cookie stay `sameSite: strict` — a
 * separate static host would force both to loosen.
 */
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'KODE Printer',
        short_name: 'KODE Print',
        description: 'Print, scan and track across KODE Sports Club',
        theme_color: '#2150A0',
        /**
         * The splash colour Android paints behind the icon while the app boots.
         *
         * It was `#0B0E16`, a near-black left over from the first build's dark
         * palette — so an installed app flashed a black screen and then landed
         * on a bone-white one, which reads as a rendering fault rather than a
         * launch. It has to match `--surface-base`.
         */
        background_color: '#f6f4f0',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icon-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        shortcuts: [
          { name: 'Print something', url: '/print', description: 'Upload and print a document' },
          { name: 'My scans', url: '/scans', description: 'Collect a scan from a printer' },
        ],
      },
      workbox: {
        // The shell is cached so the app opens instantly on a phone; API calls
        // are never cached, because a stale printer status is worse than a
        // spinner — someone would walk to a printer that is actually jammed.
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api/],
        runtimeCaching: [
          {
            urlPattern: /^\/api\//,
            handler: 'NetworkOnly',
          },
        ],
        cleanupOutdatedCaches: true,
      },
      devOptions: { enabled: false },
    }),
  ],

  build: {
    outDir: '../server/public',
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022',
    rollupOptions: {
      output: {
        // Charts are heavy and only the insights screen needs them; splitting
        // keeps the first paint on a phone away from that weight.
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          charts: ['recharts'],
        },
      },
    },
  },

  server: {
    // 5173 by default, but yields to PORT when something else already holds it.
    // Hardcoding it means a second checkout, or any other Vite project, cannot
    // run alongside this one.
    port: Number(process.env['PORT']) || 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
        /**
         * Strip the browser's `Origin` before the request reaches the API.
         *
         * In production the SPA and the API share one origin behind Caddy, so
         * a request from the app either carries no `Origin` or carries the
         * hostname that is already in `CORS_ORIGINS`. The dev proxy invents a
         * cross-origin situation that does not exist in production: the browser
         * talks to the Vite server and Vite forwards its `Origin` to the API,
         * which then measures its own frontend against the allow-list.
         *
         * That is fine until Vite cannot have port 5173 and quietly takes 5174,
         * at which point every request fails with "This origin is not allowed"
         * and the cause looks nothing like the symptom. Removing the header
         * makes dev behave the way production actually does, and leaves
         * `CORS_ORIGINS` meaning what it should: which *other* origins may call
         * this API.
         */
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.removeHeader('origin');
          });
        },
      },
    },
  },
});
