import { mount } from 'svelte';
import '@fontsource/roboto/300.css';
import '@fontsource/roboto/400.css';
import '@fontsource/roboto/500.css';
import '@fontsource/roboto/700.css';
import './app.css';
import App from './shell/Shell.svelte';

const app = mount(App, {
  target: document.getElementById('app')!
});

export default app;
