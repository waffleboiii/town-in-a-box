/** First-visit tour: three short steps, dismissible, remembered in localStorage (if available). */
import { useState } from 'react';
import { Icon } from '../icons';
import { Modal } from './common';

const STEPS = [
  {
    title: 'Pick a decision',
    text: 'Start with a big one: an AI data centre in Seine-Saint-Denis, just north of Paris. Or replay two real Paris votes, or type your own proposal.',
    art: ['datacenter', 'car', 'scooter', 'pencil'],
  },
  {
    title: 'Watch the town react',
    text: 'Switch between everyone, those who can vote, and those likely to show up. The gap between them is what a consultation would miss.',
    art: ['people', 'ballot', 'walk'],
  },
  {
    title: 'Click any resident',
    text: 'See their home, their commute, exactly what changes for them, and their simulated reaction. You can even ask them a question.',
    art: ['house', 'pin', 'chat'],
  },
];

export function Onboarding({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const s = STEPS[step];
  const last = step === STEPS.length - 1;
  return (
    <Modal onClose={onDone} labelledBy="onboard-title" className="onboard">
      <div className="row-between">
        <div className="steps" aria-label={`Step ${step + 1} of ${STEPS.length}`}>
          {STEPS.map((_, i) => (
            <i key={i} className={i <= step ? 'on' : ''} />
          ))}
        </div>
        <button type="button" className="btn btn-ghost btn-small" onClick={onDone}>
          Skip
        </button>
      </div>
      <div className="onboard-art" aria-hidden="true">
        {s.art.map((a) => (
          <Icon key={a} name={a} size={52} />
        ))}
      </div>
      <div className="kicker">
        Step {step + 1} of {STEPS.length}
      </div>
      <h2 id="onboard-title">{s.title}</h2>
      <p>{s.text}</p>
      <div className="row-between onboard-foot">
        <span className="muted small">Every voice here is simulated, not a real person.</span>
        <div className="row">
          {step > 0 ? (
            <button type="button" className="btn" onClick={() => setStep(step - 1)}>
              Back
            </button>
          ) : null}
          <button type="button" className="btn btn-primary" onClick={() => (last ? onDone() : setStep(step + 1))} autoFocus>
            {last ? 'Start exploring' : 'Next'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
