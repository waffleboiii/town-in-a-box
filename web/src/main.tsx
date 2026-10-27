import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/ui.css';

// No <StrictMode>: it mounts effects twice in development, which would create and destroy
// the WebGL town map twice on start-up. The app itself does not rely on that check.
createRoot(document.getElementById('root')!).render(<App />);
