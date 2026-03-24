import { render } from 'preact';
import { App } from './app';
import '@xterm/xterm/css/xterm.css';
import './styles/fonts.css';
import './styles/variables.css';
import './styles/global.css';
import './styles/app.css';

render(<App />, document.getElementById('app')!);

// Register service worker for PWA installability (standalone mode, no browser URL bar)
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
