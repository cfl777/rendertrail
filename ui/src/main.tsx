import { useApp, useHostStyles } from '@modelcontextprotocol/ext-apps/react';
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BRAND } from '../../src/brand';
import { SCHEMA_VERSION, type InspectRenderOutput } from '../../src/shared/types';

// Phase 1 placeholder: shows what was recorded. The real card (HANDOFF.md §8) is Phase 3.

function isOutput(value: unknown): value is InspectRenderOutput {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.schemaVersion === SCHEMA_VERSION && (typeof v.run === 'object' || typeof v.error === 'object');
}

function Card() {
  const [output, setOutput] = useState<InspectRenderOutput | null>(null);
  const { app, error } = useApp({
    appInfo: { name: BRAND.displayName, version: '0.0.0' },
    capabilities: {},
    onAppCreated: (created) => {
      // Handlers must be registered before connect(), which useApp calls next.
      created.ontoolresult = (params) => {
        if (isOutput(params.structuredContent)) setOutput(params.structuredContent);
      };
    },
  });
  useHostStyles(app, app?.getHostContext());

  if (error) return <p className="meta">Couldn't connect to the host: {error.message}</p>;

  if (!output) {
    return (
      <main className="card">
        <p className="caption">{BRAND.displayName}</p>
        <h1 className="headline">Recording…</h1>
      </main>
    );
  }

  if ('error' in output) {
    return (
      <main className="card">
        <p className="caption">{BRAND.displayName}</p>
        <h1 className="headline">Couldn't record: {output.error.message}</h1>
        {output.error.stubs.length > 0 && <p className="meta">Stubbed imports: {output.error.stubs.join(', ')}</p>}
      </main>
    );
  }

  const { run } = output;
  return (
    <main className="card">
      <p className="caption">
        {BRAND.displayName} · {run.entry}
      </p>
      <h1 className="headline">
        Recorded {run.commitCount} updates in {run.runs} runs
      </h1>
      <p className="meta">
        Each input update takes {run.timings.inputMedianMs.toFixed(1)} ms
        {run.stable ? '' : ' · counts differed between runs'}
      </p>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Card />
  </StrictMode>,
);
