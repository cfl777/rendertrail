/**
 * The recorded page gets no network access: fetch, WebSocket, window.open, images and a service
 * worker registration must never reach a local server started by the test.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordRender } from '../../src/recorder/index.js';
import { InspectRenderInputSchema } from '../../src/shared/types.js';

const hits: string[] = [];
const server = http.createServer((req, res) => {
  hits.push(`${req.method} ${req.url}`);
  res.end('ok');
});
server.on('upgrade', (req, socket) => {
  hits.push(`UPGRADE ${req.url}`);
  socket.destroy();
});
let port = 0;

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const APP = [
  `import { useEffect, useState } from 'react';`,
  ``,
  `export default function Leaky({ port }: { port: number }) {`,
  `  const [status, setStatus] = useState('start');`,
  `  useEffect(() => {`,
  `    for (const host of ['127.0.0.1', 'localhost']) {`,
  `      const base = 'http://' + host + ':' + port;`,
  `      fetch(base + '/fetch').then(() => setStatus('fetched'), () => setStatus('fetch blocked'));`,
  `      try {`,
  `        const ws = new WebSocket('ws://' + host + ':' + port + '/ws');`,
  `        ws.onopen = () => setStatus('ws open');`,
  `      } catch {}`,
  `      window.open(base + '/popup');`,
  `      const img = new Image();`,
  `      img.src = base + '/img.png';`,
  `      navigator.serviceWorker?.register(base + '/sw.js').catch(() => {});`,
  `    }`,
  `  }, []);`,
  `  return <p>{status}</p>;`,
  `}`,
].join('\n');

describe('network isolation', () => {
  it('the server is reachable from Node (so the next test can fail)', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/check`);
    expect(await response.text()).toBe('ok');
    expect(hits).toEqual(['GET /check']);
    hits.length = 0;
  });

  it('fetch, WebSocket, window.open, images and service workers never reach it', async () => {
    const result = await recordRender(
      InspectRenderInputSchema.parse({
        files: [{ path: 'Leaky.tsx', content: APP }],
        entry: 'Leaky.tsx',
        props: { port },
        steps: [{ action: 'wait', ms: 1500 }],
      }),
    );
    if (!result.ok) throw new Error(JSON.stringify(result.error, null, 2));
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(hits).toEqual([]);
  });
});
