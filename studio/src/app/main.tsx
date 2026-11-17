import { createRoot } from 'react-dom/client';
import { App } from './App';
import { LocaleProvider } from '../../vendor/stacki/src/lib/i18n/LocaleProvider';
import '../../vendor/stacki/src/app/styles.css';
import '../../vendor/stacki/src/features/style/tokens.css';
import './studio.css';
const root = document.getElementById('root');
if (!root) {
  throw new Error('Studio root is missing');
}
createRoot(root).render(
  <LocaleProvider>
    <App />
  </LocaleProvider>,
);
