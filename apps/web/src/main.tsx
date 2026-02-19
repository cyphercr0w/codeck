import { render } from 'preact';
import { App } from './app';
import '@xterm/xterm/css/xterm.css';
import './styles/variables.css';
import './styles/global.css';
import './styles/app.css';

render(<App />, document.getElementById('app')!);
