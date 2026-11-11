/**
 * Smoke test of the packaged server: spawns dist/server.js over stdio and calls inspect_render, so
 * dist/instrument.js and React resolution from dist/ are exercised. `npm run test:golden` builds first.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SERVER = path.join(ROOT, 'dist', 'server.js');
const FIXTURE = path.join(ROOT, 'fixtures', 'laggy-search');
const built = existsSync(SERVER) && existsSync(path.join(ROOT, 'dist', 'instrument.js'));

interface RpcResponse {
  id?: number;
  result?: { content?: { type: string; text: string }[]; structuredContent?: { schemaVersion?: number } };
}

describe.skipIf(!built)('stdio smoke test (needs `npm run build`; skipped when dist/ is missing)', () => {
  it('inspect_render records laggy-search through dist/server.js', async () => {
    const names = (await readdir(FIXTURE)).filter((name) => /\.tsx?$/.test(name) && !name.includes('.fixed'));
    const files = await Promise.all(
      names.map(async (name) => ({ path: name, content: await readFile(path.join(FIXTURE, name), 'utf8') })),
    );
    const test = JSON.parse(await readFile(path.join(FIXTURE, 'test.json'), 'utf8')) as Record<string, unknown>;

    const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'inherit'] });
    const pending = new Map<number, (message: RpcResponse) => void>();
    let buffer = '';
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          const message = JSON.parse(line) as RpcResponse;
          if (message.id !== undefined) pending.get(message.id)?.(message);
        }
        newline = buffer.indexOf('\n');
      }
    });
    let nextId = 0;
    const send = (message: object): void => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    };
    const rpc = (method: string, params: object): Promise<RpcResponse> =>
      new Promise((resolve) => {
        nextId += 1;
        pending.set(nextId, resolve);
        send({ id: nextId, method, params });
      });

    try {
      await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } });
      send({ method: 'notifications/initialized' });
      const call = await rpc('tools/call', { name: 'inspect_render', arguments: { ...test, files } });
      const text = call.result?.content?.[0]?.text ?? '';
      expect(text, text).toContain('Render counts were identical in all 3 runs.');
      expect(text).toContain(
        'Renders after mount: SearchPage 6, Layout 6, Header 6, SearchBox 11, ResultsList 6, ResultRow 1050, Sidebar 0.',
      );
      expect(call.result?.structuredContent?.schemaVersion).toBe(1);

      // The card resource: one self-contained HTML file, well under 1 MB.
      const read = (await rpc('resources/read', { uri: 'ui://rendertrail/card.html' })) as {
        result?: { contents?: { mimeType?: string; text?: string; _meta?: { ui?: { prefersBorder?: boolean; permissions?: Record<string, unknown> } } }[] };
      };
      const card = read.result?.contents?.[0];
      expect(card?.mimeType).toBe('text/html;profile=mcp-app');
      expect(card?._meta?.ui?.prefersBorder).toBe(false);
      expect(card?._meta?.ui?.permissions).toEqual({ clipboardWrite: {} });
      expect(card?.text).toContain('<title>Rendertrail</title>');
      expect(card?.text).toContain('<div id="root"></div>');
      expect(card?.text).not.toMatch(/<script[^>]+src=/);
      expect(Buffer.byteLength(card?.text ?? '', 'utf8')).toBeLessThan(1024 * 1024);
    } finally {
      child.kill();
    }
  });
});
