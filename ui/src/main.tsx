import { useApp, useHostStyles } from '@modelcontextprotocol/ext-apps/react';
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BRAND } from '../../src/brand';
import { SCHEMA_VERSION, type HelloResult } from '../../src/shared/types';

function isHelloResult(value: unknown): value is HelloResult {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.schemaVersion === SCHEMA_VERSION && typeof v.greeting === 'string';
}

function Card() {
  const [result, setResult] = useState<HelloResult | null>(null);
  const { app, error } = useApp({
    appInfo: { name: BRAND.displayName, version: '0.0.0' },
    capabilities: {},
    onAppCreated: (created) => {
      // Handlers must be registered before connect(), which useApp calls next.
      created.ontoolresult = (params) => {
        if (isHelloResult(params.structuredContent)) setResult(params.structuredContent);
      };
    },
  });
  useHostStyles(app, app?.getHostContext());

  if (error) return <p className="meta">Couldn't connect to the host: {error.message}</p>;

  return (
    <main className="card">
      <p className="caption">{BRAND.displayName} · test card</p>
      <h1 className="headline">{result ? result.greeting : 'Waiting for the result…'}</h1>
      {result && <p className="meta">Server time {result.serverTime}</p>}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Card />
  </StrictMode>,
);
