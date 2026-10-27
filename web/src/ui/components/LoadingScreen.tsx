/** Full-screen loading view with a pixel progress bar (data download + texture generation). */
import { Icon } from '../icons';

const BLOCKS = 20;

export function LoadingScreen({ progress, label, done, error }: { progress: number; label: string; done: boolean; error?: string | null }) {
  const on = Math.round(Math.max(0, Math.min(1, progress)) * BLOCKS);
  return (
    <div className={`loading ${done ? 'done' : ''}`} aria-hidden={done}>
      <div className="panel loading-box" role="status" aria-live="polite">
        <div className="bob">
          <Icon name="house" size={64} />
        </div>
        <h1>Town-in-a-Box</h1>
        <p>Building a simulated Paris to rehearse your consultation.</p>
        <div className="loadbar" aria-hidden="true">
          {Array.from({ length: BLOCKS }, (_, i) => (
            <i key={i} className={i < on ? 'on' : ''} />
          ))}
        </div>
        {error ? (
          <p className="banner banner-error banner-block">
            {error}
          </p>
        ) : (
          <div className="loading-stage">
            {label}… {Math.round(progress * 100)}%
          </div>
        )}
      </div>
    </div>
  );
}
