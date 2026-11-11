/**
 * The card (HANDOFF.md §8), driven only by structuredContent and the tool arguments. States:
 * waiting (nothing yet), receiving (the arguments arrived, recording), answer, comparison (a
 * re-run with a baseline) and couldn't record.
 */
import { useState } from 'react';
import { BRAND } from '../../src/brand';
import type { Finding } from '../../src/shared/types';
import {
  comparisonHeadline,
  errorHeadline,
  findingTitle,
  fixMessage,
  isError,
  locationText,
  msText,
  prSummary,
  RETRY_MESSAGE,
  stepWords,
  type CardState,
  type ErrorOutput,
  type HostActions,
  type ResultOutput,
} from './model';
import { BeforeAfter, Caption, CodeChanges, CodeText, Disclosure, FindingChips, Notes, Skeleton, TimeBar, Tree } from './parts';

export function Card({ state, host }: { state: CardState; host: HostActions }) {
  const { output } = state;
  if (!output) return <Waiting state={state} />;
  if (isError(output)) return <CouldNotRecord output={output} host={host} />;
  return <Result output={output} state={state} host={host} />;
}

function Waiting({ state }: { state: CardState }) {
  const input = state.input;
  const what = input?.entry ? input.entry.replace(/\.[^./]+$/, '') : null;
  return (
    <main className="card" aria-busy="true" data-state={input ? 'receiving' : 'waiting'}>
      <Caption>
        {BRAND.displayName} · {state.recording ? `recording${what ? ` ${what}` : ''}…` : input ? 'receiving code…' : 'waiting for the code…'}
      </Caption>
      {input && input.paths.length > 0 && (
        <ul className="file-chips" aria-label="Files sent">
          {input.paths.map((p) => (
            <li key={p}>
              <code>{p}</code>
            </li>
          ))}
        </ul>
      )}
      <Skeleton />
    </main>
  );
}

function CouldNotRecord({ output, host }: { output: ErrorOutput; host: HostActions }) {
  const e = output.error;
  return (
    <main className="card" data-state="error">
      <Caption>{BRAND.displayName} · couldn't record</Caption>
      <h1 className="headline">{errorHeadline(e.kind)}</h1>
      <p className="subline">{e.message}</p>
      {e.details.length > 0 && (
        <pre className="details">
          <code>{e.details.slice(0, 6).join('\n')}</code>
        </pre>
      )}
      {e.stubs.length > 0 && (
        <section className="stubs" aria-label="Imports that were stubbed">
          <h2>Imports that weren't sent</h2>
          <p className="muted">They were replaced with stand-ins. If they matter, send these files too.</p>
          <ul className="file-chips">
            {e.stubs.map((s) => (
              <li key={s}>
                <code>{s}</code>
              </li>
            ))}
          </ul>
        </section>
      )}
      <Actions primary={{ label: 'Fix the input and try again', message: RETRY_MESSAGE }} host={host} />
    </main>
  );
}

/** Notes about the recording itself: unstable counts, a cut-off recording, stand-ins. */
function recordingNotes(output: ResultOutput): string[] {
  const s = output.run.summary;
  const notes: string[] = [];
  if (!s.stable) notes.push(`The ${s.runs} recordings didn't match exactly, so the numbers come from the first one and may be off.`);
  if (s.truncated) notes.push(`The recording stopped after ${s.commitCount} updates; later ones weren't recorded.`);
  if (s.stubs.length) notes.push(`Stand-ins were used for imports that weren't sent: ${s.stubs.join(', ')}.`);
  return notes;
}

function Result({ output, state, host }: { output: ResultOutput; state: CardState; host: HostActions }) {
  const c = output.comparison;
  if (c?.found) return <Compared output={output} state={state} host={host} />;
  return <Answer output={output} host={host} note={c && !c.found ? c.message : null} />;
}

function Answer({ output, host, note }: { output: ResultOutput; host: HostActions; note: string | null }) {
  const k = output.keystroke;
  const [top, ...more] = output.findings;
  const opened = (f: Finding) => (what: string) => host.noteOpened(`The user opened “${what}” in the ${BRAND.displayName} card for: ${f.texts.summary}`);
  return (
    <main className="card" data-state={top ? 'answer' : 'no-findings'}>
      <Caption>
        {BRAND.displayName} · {k.caption}
      </Caption>
      {note && <p className="callout">{note}</p>}
      <h1 className="headline">{k.headline}</h1>
      <p className="subline">{k.subline}</p>
      {k.steps > 0 && <TimeBar k={k} />}
      {!top && k.steps > 0 && (
        <p className="raw" data-testid="raw-cost">
          {stepWords(k).per[0]!.toUpperCase() + stepWords(k).per.slice(1)}: {msText(k.msPerStep)}, {Math.round(k.rendersPerStep * 10) / 10} component renders (median of{' '}
          {k.steps} {k.steps === 1 ? stepWords(k).noun : `${stepWords(k).noun}s`}). Nothing else stands out.
        </p>
      )}
      <Tree k={k} />
      {top && <FindingChips finding={top} onOpen={opened(top)} idPrefix="top" />}
      {more.length > 0 && (
        <section className="more" aria-label="Also found">
          <h2>Also found</h2>
          {more.map((f, i) => (
            <Disclosure
              key={f.id}
              id={`more-${i}`}
              className="disclosure more-item"
              label={`${findingTitle(f)}${locationText(f) ? ` · ${locationText(f)}` : ''}`}
              onOpen={() => opened(f)('Also found')}
            >
              <p>
                <CodeText text={f.texts.why} />
              </p>
              <p>
                <CodeText text={f.texts.fix} />
              </p>
            </Disclosure>
          ))}
        </section>
      )}
      <Notes items={recordingNotes(output)} />
      {top && <Actions primary={{ label: 'Fix it and check', message: fixMessage(k) }} host={host} />}
    </main>
  );
}

function Compared({ output, state, host }: { output: ResultOutput; state: CardState; host: HostActions }) {
  const c = output.comparison!;
  const k = output.keystroke;
  const remaining = c.stillThere.length + c.new.length;
  const groups = [
    { key: 'resolved', title: 'Resolved', dot: 'dot-success', refs: c.resolved },
    { key: 'still', title: 'Still there', dot: 'dot-warning', refs: c.stillThere },
    { key: 'new', title: 'New', dot: 'dot-danger', refs: c.new },
  ].filter((g) => g.refs.length > 0);
  const notes = recordingNotes(output);
  if (!c.sameInteraction) notes.unshift('The interaction differs from the earlier run, so the numbers may not be comparable.');
  const current = state.input && state.input.files.length > 0 ? state.input.files : null;
  const where = (id: string): string | null => {
    const f = output.findings.find((x) => x.id === id);
    return f ? locationText(f) : null;
  };

  return (
    <main className="card" data-state={c.checked ? 'comparison' : 'unchecked'}>
      <Caption>
        {BRAND.displayName} · {k.caption}
      </Caption>
      <h1 className="headline">{comparisonHeadline(c, output)}</h1>
      <p className="subline">{c.checked ? k.subline : c.message}</p>
      {c.checked && c.before && c.after && (
        <BeforeAfter before={c.before.msPerStep} after={c.after.msPerStep} beforeRenders={c.before.rendersPerStep} afterRenders={c.after.rendersPerStep} k={k} />
      )}
      {groups.length > 0 && (
        <ul className="status-list">
          {groups.flatMap((g) =>
            g.refs.map((r) => (
              <li key={r.id} data-status={g.key}>
                <span className={`dot ${g.dot}`} aria-hidden="true" />
                <span>
                  <strong>{g.title}:</strong> <CodeText text={r.summary} />
                  {g.key !== 'resolved' && where(r.id) && <span className="muted"> · {where(r.id)}</span>}
                </span>
              </li>
            )),
          )}
        </ul>
      )}
      {c.checked && groups.length === 0 && <p className="muted">No problems were found in either run.</p>}
      {c.changedFiles.length > 0 && (
        <Disclosure id="changes" label="What changed in my code?" onOpen={() => host.noteOpened(`The user opened “What changed in my code?” in the ${BRAND.displayName} card.`)}>
          <CodeChanges changedFiles={c.changedFiles} baselineFiles={c.baselineFiles} currentFiles={current} />
        </Disclosure>
      )}
      {c.changedFiles.length === 0 && <p className="muted">No files changed since run {c.baselineRunId}.</p>}
      <Notes items={notes} />
      {c.checked && (
        <Actions
          primary={remaining > 0 ? { label: 'Fix it and check', message: fixMessage(k) } : null}
          copy={prSummary(output)}
          host={host}
        />
      )}
    </main>
  );
}

type Status = { kind: 'idle' } | { kind: 'done'; text: string } | { kind: 'failed'; text: string };

/** At most 2 actions: "Fix it and check" (or "try again") and "Copy for PR". */
function Actions(props: { primary: { label: string; message: string } | null; copy?: string; host: HostActions }) {
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [showCopy, setShowCopy] = useState(false);
  const send = async (message: string): Promise<void> => {
    const ok = await props.host.sendMessage(message).catch(() => false);
    setStatus(ok ? { kind: 'done', text: 'Added to the message box. Send it when you’re ready.' } : { kind: 'failed', text: `Couldn't reach the chat. Type this instead: “${message}”` });
  };
  const copy = async (text: string): Promise<void> => {
    const ok = await props.host.copyText(text).catch(() => false);
    setShowCopy(!ok);
    setStatus(ok ? { kind: 'done', text: 'Copied. Paste it into the pull request.' } : { kind: 'failed', text: "Couldn't copy here. Select the text below and copy it." });
  };
  return (
    <div className="actions-wrap">
      <div className="actions">
        {props.primary && (
          <button type="button" className="button primary" onClick={() => void send(props.primary!.message)}>
            {props.primary.label}
          </button>
        )}
        {props.copy !== undefined && (
          <button type="button" className={`button ${props.primary ? 'secondary' : 'primary'}`} onClick={() => void copy(props.copy!)}>
            Copy for PR
          </button>
        )}
      </div>
      <p className="status" role="status" data-status={status.kind}>
        {status.kind === 'idle' ? '' : status.text}
      </p>
      {showCopy && props.copy && <pre className="copy-text">{props.copy}</pre>}
    </div>
  );
}
