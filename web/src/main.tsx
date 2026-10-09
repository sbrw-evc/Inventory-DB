import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ApiRequestError } from './api/client';
import { App } from './App';
import { getLang } from './i18n';
import { AuthProvider } from './lib/auth';
import { installScrollbars } from './lib/scrollbars';
import './lib/theme';
import './styles/app.css';
import './styles/grid.css';
import './styles/components.css';
import './styles/mobile.css';

document.documentElement.lang = getLang();
installScrollbars();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: (count, err) => !(err instanceof ApiRequestError && err.status >= 400 && err.status < 500) && count < 2,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
