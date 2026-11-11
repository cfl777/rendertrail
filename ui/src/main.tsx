import { useApp, useHostStyles, type App } from '@modelcontextprotocol/ext-apps/react';
import { StrictMode, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import pkg from '../../package.json';
import { BRAND } from '../../src/brand';
import { Card } from './Card';
import { copyText } from './clipboard';
import { parseOutput, parseToolInput, type CardState, type HostActions } from './model';

function hostActions(app: App | null): HostActions {
  return {
    sendMessage: async (text) => {
      if (!app) return false;
      const result = await app.sendMessage({ role: 'user', content: [{ type: 'text', text }] });
      return !result.isError;
    },
    copyText,
    noteOpened: (text) => {
      // Optional (HANDOFF.md §8): lets Claude know what the user looked at.
      app?.updateModelContext({ content: [{ type: 'text', text }] }).catch(() => undefined);
    },
  };
}

function Root() {
  const [state, setState] = useState<CardState>({ input: null, recording: false, output: null });
  const { app, error } = useApp({
    appInfo: { name: BRAND.displayName, version: pkg.version },
    capabilities: {},
    // useApp reports the card's height to the host (autoResize), so the host iframe grows with it.
    onAppCreated: (created) => {
      // Listeners must be in place before connect(), which useApp calls next.
      created.addEventListener('toolinputpartial', (params) => {
        const input = parseToolInput(params.arguments);
        if (input) setState((s) => (s.output ? s : { ...s, input }));
      });
      created.addEventListener('toolinput', (params) => {
        const input = parseToolInput(params.arguments);
        setState((s) => ({ ...s, input: input ?? s.input, recording: true }));
      });
      created.addEventListener('toolresult', (params) => {
        const output = parseOutput(params.structuredContent);
        if (output) setState((s) => ({ ...s, output }));
      });
    },
  });
  useHostStyles(app, app?.getHostContext());
  const host = useMemo(() => hostActions(app), [app]);

  if (error) return <p className="caption">Couldn't connect to the host: {error.message}</p>;
  return <Card state={state} host={host} />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
