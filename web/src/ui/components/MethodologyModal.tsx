/** "How it works": the method in plain English, what is computed vs generated vs imputed, limits, sources. */
import type { ApiHealth, Scenario } from '../../types';
import { useApp } from '../context';
import { Icon } from '../icons';
import { ComputedChip, ImputedChip, Modal, VoiceChip } from './common';

export function MethodologyModal({ onClose, health }: { onClose: () => void; health: ApiHealth | null }) {
  const { data, scenario } = useApp();
  const issues = data.population.method?.knownDatasetIssues ?? [];
  const sources = dedupeSources([
    ...(data.map.sources ?? []),
    ...(data.population.sources ?? []),
    ...((scenario?.backtest?.sources ?? []) as { name: string; url: string; license?: string }[]),
  ]);
  return (
    <Modal onClose={onClose} labelledBy="method-title">
      <div className="panel-head">
        <div className="head-text">
          <h2 id="method-title">How Town-in-a-Box works</h2>
          <p className="panel-sub">A rehearsal space for planners. Every result is a hypothesis to check with real people.</p>
        </div>
        <button type="button" className="btn btn-icon" onClick={onClose} aria-label="Close">
          <Icon name="close" size={16} />
        </button>
      </div>
      <div className="panel-body">
        <p>
          Before a public consultation, test a proposal on a simulated population: who it touches, who would object and why, and which voices a
          consultation would miss because those people rarely take part.
        </p>

        <h3>The pipeline, step by step</h3>
        <ol>
          <li>
            <b>Sample residents.</b> 2,000 synthetic people from NVIDIA’s Nemotron-Personas-France dataset, for Paris and the inner suburbs (départements 75,
            92, 93 and 94).
          </li>
          <li>
            <b>Correct the sample.</b> The dataset follows the national occupation mix (about 9.7% managers, against about 31.9% in Paris), so the sample is
            raked to INSEE statistics. About half the Paris rows have no arrondissement; one is assigned together with occupation and education, never at random.
          </li>
          <li>
            <b>Fill in what is missing.</b> The dataset has no income, housing tenure, car, commute or nationality. These are estimated from INSEE statistics
            and labelled <ImputedChip /> everywhere.
          </li>
          <li>
            <b>Compute what changes for each resident</b> from where they live and work and their situation. This is plain code, not AI <ComputedChip />.
          </li>
          <li>
            <b>Ask the AI for a reaction.</b> The profile, the computed facts and the proposal text go to NVIDIA Nemotron models on Nebius Token Factory. The
            model writes a stance, a reason in the resident’s own voice and what they would do <VoiceChip />.
          </li>
          <li>
            <b>Estimate who shows up.</b> Participation comes from real turnout patterns (age, education, housing) and how much the issue touches each person.
            The AI’s own “would you take part?” only nudges the ranking. The share of likely participants is set to the real (or assumed) turnout.
          </li>
          <li>
            <b>Let neighbours talk.</b> A few hundred pairs of neighbours have a short conversation. We track which arguments spread and whether anyone changes
            their mind, and test whether this makes the backtest more or less accurate.
          </li>
          <li>
            <b>Summarise.</b> Themes, the gap between everyone and likely participants, and a “who to consult” outreach plan.
          </li>
        </ol>

        <h3>Computed, generated or imputed?</h3>
        <table className="tbl">
          <tbody>
            <tr>
              <td>
                <ComputedChip>computed</ComputedChip>
              </td>
              <td>What changes for each resident, participation and likely participants, every percentage and gap, backtest errors.</td>
            </tr>
            <tr>
              <td>
                <VoiceChip />
              </td>
              <td>Stances, reasons, what people would do, neighbour conversations, answers to your questions, theme labels.</td>
            </tr>
            <tr>
              <td>
                <ImputedChip />
              </td>
              <td>Car and heavy car, housing tenure, nationality and the right to vote, workplace and commute, and some arrondissements.</td>
            </tr>
            <tr>
              <td>
                <span className="chip">dataset</span>
              </td>
              <td>Name, age, sex, occupation, education, household, persona text, and the commune when present.</td>
            </tr>
          </tbody>
        </table>

        <h3>Limits to keep in mind</h3>
        <ul>
          <li>Simulated people are not real people. Results are hypotheses to test with residents, never evidence of public opinion.</li>
          <li>Language models can stereotype, agree too easily or sound too alike. Neutral prompts and uncertainty ranges help, but bias remains.</li>
          <li>Imputed attributes are statistical guesses: right on average, wrong for many individuals.</li>
          <li>2,000 residents is a small town, so district-level numbers are noisy.</li>
          {issues.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>

        <h3>Could the model just remember the real votes?</h3>
        <p>
          The two real votes took place in April 2023 and February 2024. Nemotron 3 was trained on data up to about June 2025, so it may have read the
          results. We ask the bare model, with no persona, what the result was. The Backtest tab shows that probe and its verdict: if the model knows the
          answer, the backtest is weaker evidence.
        </p>

        <h3>This run</h3>
        <RunInfo scenario={scenario} health={health} demo={data.sources} />

        <h3>Sources and licences</h3>
        <ul>
          <li>
            Residents: <a href="https://huggingface.co/datasets/nvidia/Nemotron-Personas-France">Nemotron-Personas-France</a> by NVIDIA, licensed{' '}
            <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>. Changes: sampled, re-weighted to INSEE statistics, attributes imputed,
            English one-liners added.
          </li>
          <li>Reactions and conversations: NVIDIA Nemotron models served by Nebius Token Factory.</li>
          <li>Official vote results: Ville de Paris (paris.fr). Statistics: INSEE.</li>
          {sources.map((s) => (
            <li key={s.name}>
              {s.url ? <a href={s.url}>{s.name}</a> : s.name}
              {s.license ? `, ${s.license}` : ''}
            </li>
          ))}
          <li>Map and characters: original cozy pixel art drawn in code for this project.</li>
        </ul>
      </div>
    </Modal>
  );
}

function RunInfo({ scenario, health, demo }: { scenario: Scenario | null; health: ApiHealth | null; demo: { map: string; population: string; scenarios: string } }) {
  const anyDemo = Object.values(demo).includes('demo');
  return (
    <ul>
      <li>
        Data: {anyDemo ? 'built-in demo data for some parts (pipeline files not found)' : 'files produced by the pipeline'} (map: {demo.map}, residents:{' '}
        {demo.population}, scenarios: {demo.scenarios}).
      </li>
      {scenario ? (
        <li>
          This scenario: reactions by <b>{scenario.models.reaction}</b>
          {scenario.models.conversation ? `, conversations by ${scenario.models.conversation}` : ''}.{' '}
          {scenario.mock ? 'Mock run: heuristic answers, no AI involved yet.' : 'Real model run.'}
        </li>
      ) : null}
      <li>
        Live API:{' '}
        {health ? (health.mock ? 'running in mock mode (no API key configured yet).' : `connected (${health.models.reaction}).`) : 'not reachable here; live features use in-browser demo answers.'}
      </li>
    </ul>
  );
}

function dedupeSources(list: { name: string; url: string; license?: string }[]) {
  const seen = new Set<string>();
  return list.filter((s) => {
    if (!s?.name || seen.has(s.name)) return false;
    seen.add(s.name);
    return true;
  });
}
