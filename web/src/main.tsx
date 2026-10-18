import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { ErrorBoundary } from '@/app/ErrorBoundary';
import { NavigationBridge } from '@/app/NavigationBridge';
import { ReauthProvider } from '@/features/mfa/ReauthProvider';
import { ToastProvider } from '@/shared/components/Toast';
import { queryClient } from '@/app/queryClient';
import './index.css';

// Mount point from index.html.
const root = document.getElementById('root');
if (!root) throw new Error('missing #root');

// App providers: data cache, router, toasts, re-auth modal, error boundary.
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ToastProvider>
          <NavigationBridge />
          <ReauthProvider>
            <ErrorBoundary>
              <App />
            </ErrorBoundary>
          </ReauthProvider>
        </ToastProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
