import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App.js';
import { ApiError } from './lib/api.js';
import { AuthProvider } from './lib/auth.js';
import { ToastProvider } from './components/ui.js';
import { initialiseServiceWorker } from './lib/pwa.js';
import './styles/theme.css';
import './styles/components.css';
import './styles/motion.css';

/**
 * Query client defaults.
 *
 * `retry` is the interesting one. Retrying a 4xx is pointless — a 403 will be a
 * 403 on the third attempt too — and retrying a 401 actively fights the token
 * refresh in `api.ts`, which already handles that case exactly once. So only
 * genuine network failures and 5xx get a second chance.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      // The SSE stream is what keeps data fresh; refetching on every window
      // focus would double the traffic for no additional freshness.
      refetchOnWindowFocus: false,
      retry: (failureCount, error) => {
        if (error instanceof ApiError) {
          if (error.code === 'NETWORK_ERROR') return failureCount < 2;
          return error.status >= 500 && failureCount < 2;
        }
        return false;
      },
      retryDelay: (attempt) => Math.min(4000, 500 * 2 ** attempt),
    },
    mutations: {
      // A mutation retried automatically could print two copies. Never.
      retry: false,
    },
  },
});

/**
 * Theme resolution happens before React mounts, so there is no flash of the
 * wrong palette on a cold PWA launch.
 */
const stored = localStorage.getItem('kode-theme');
if (stored === 'light' || stored === 'dark') {
  document.documentElement.dataset['theme'] = stored;
}

/* Registered before React mounts, so a returning visitor is served the cached
 * shell on the next load rather than the one after that. */
initialiseServiceWorker();

const root = document.getElementById('root');
if (!root) throw new Error('#root is missing from index.html');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <ToastProvider>
            <App />
          </ToastProvider>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
