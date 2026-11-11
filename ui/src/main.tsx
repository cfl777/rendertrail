import { useApp, useHostStyles, type App } from '@modelcontextprotocol/ext-apps/react';
import { StrictMode, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BRAND } from '../../src/brand';
import { Card } from './Card';
import { copyText } from './clipboard';
import { applyCancelled, applyToolResult, EMPTY_STATE, openedTracker, parseToolInput, type CardState, type HostActions } from './model';

function hostActions(app: App | null): HostActions {
  return {
    sendMessage: async (text) => {
      if (!app) return false;
      const result = await app.sendMessage({ role: 'user', content: [{ type: 'text', text }] });
      return !result.isError;
    },
    copyText,
    // Optional (HANDOFF.md §8): lets Claude know what the user looked at. Each call replaces the
    // last, so the tracker always sends everything opened so far.
    noteOpened: openedTracker((text) => {
      app?.updateModelContext({ content: [{ type: 'text', text }] }).catch(() => undefined);
    }),
  };
}

function Root() {
  const [state, setState] = useState<CardState>(EMPTY_STATE);
  const { app, error } = useApp({
    appInfo: { name: BRAND.displayName, version: __CARD_VERSION__ },
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
      created.addEventListener('toolresult', (params) => setState((s) => applyToolResult(s, params)));
      created.addEventListener('toolcancelled', (params) => setState((s) => applyCancelled(s, params.reason)));
    },
  });
  useHostStyles(app, app?.getHostContext());
  const host = useMemo(() => hostActions(app), [app]);

  if (error) return <p className="caption">Couldn't connect to the host: {error.message}</p>;
  return <Card state={state} host={host} />;
}

document.title = BRAND.displayName;
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
