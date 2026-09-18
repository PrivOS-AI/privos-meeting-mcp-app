import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { PrivosAppProvider } from '@privos_ai/app-react';

import { App } from './app.js';
import { I18nProvider } from './i18n/i18n-provider.js';
import { ThemeProvider } from './theme/theme-provider.js';
import './theme/tokens.css';
import './theme/app-shell.css';
import './theme/recording.css';

const container = document.getElementById('root');
if (!container) throw new Error('Root element is missing from the app document.');

createRoot(container).render(
  <StrictMode>
    <PrivosAppProvider name="Meeting Agent" version="0.1.0">
      <I18nProvider>
        <ThemeProvider>
          <App />
        </ThemeProvider>
      </I18nProvider>
    </PrivosAppProvider>
  </StrictMode>,
);
