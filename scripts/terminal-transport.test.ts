import assert from 'node:assert/strict';
import test from 'node:test';
import { resetApiBaseForTest } from '../src/services/apiBase.ts';
import { resizeDesktopTerminal, writeDesktopTerminal } from '../src/services/desktopTerminal.ts';
import { createWebTerminal, killWebTerminal, subscribeWebTerminalEvents } from '../src/services/webTerminal.ts';

function stubTransport(mode: 'desktop' | 'browser', call: (command: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>) {
  const host = globalThis as typeof globalThis & { __TAURI_INTERNALS__?: { invoke: typeof invoke } };
  const originalTauri = host.__TAURI_INTERNALS__;
  const originalFetch = globalThis.fetch;
  async function invoke(command: string, args: Record<string, unknown> = {}) { await call(command, args); }
  if (mode === 'desktop') host.__TAURI_INTERNALS__ = { invoke };
  else delete host.__TAURI_INTERNALS__;
  globalThis.fetch = async (input, init) => {
    const result = await call(String(input).split('/').at(-1)!, JSON.parse(String(init?.body)), init?.signal ?? undefined);
    return new Response(JSON.stringify({ result: result ?? null }));
  };
  resetApiBaseForTest();
  return () => {
    globalThis.fetch = originalFetch;
    host.__TAURI_INTERNALS__ = originalTauri;
    resetApiBaseForTest();
  };
}

test('a stalled browser terminal read does not delay another terminal, and close cancels it', async () => {
  const firstRead = Promise.withResolvers<AbortSignal | undefined>();
  const releaseRead = Promise.withResolvers<void>();
  const secondOutput = Promise.withResolvers<string>();
  const restore = stubTransport('browser', async (command, args, signal) => {
    if (command === 'terminal_create') return { sessionId: args.workspacePath, shell: 'sh', cwd: args.workspacePath };
    if (command !== 'terminal_read') return;
    if (args.sessionId === 'stalled') {
      firstRead.resolve(signal);
      await releaseRead.promise;
    }
    return { chunks: [btoa('ready')], cursor: 1, exited: false, more: false };
  });
  const deadline = Promise.withResolvers<never>();
  const timeout = setTimeout(() => deadline.reject(new Error('The terminals did not complete the expected reads')), 2_000);
  const stop = subscribeWebTerminalEvents({
    onOutput: event => { if (event.sessionId === 'responsive') secondOutput.resolve(atob(event.data)); },
    onExit: () => {},
  });
  try {
    await createWebTerminal('stalled');
    const signal = await Promise.race([firstRead.promise, deadline.promise]);
    await createWebTerminal('responsive');
    assert.equal(await Promise.race([secondOutput.promise, deadline.promise]), 'ready');
    await killWebTerminal('stalled');
    assert.ok(signal?.aborted, 'closing the stalled terminal must abort its read');
  } finally {
    clearTimeout(timeout);
    stop();
    releaseRead.resolve();
    await Promise.all(['stalled', 'responsive'].map(killWebTerminal));
    restore();
  }
});

for (const mode of ['desktop', 'browser'] as const) {
  test(`${mode} terminal resizes finish in order without blocking another session`, async () => {
    const firstStarted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const sizes: number[] = [];
    const restore = stubTransport(mode, async (command, args) => {
      assert.equal(command, 'terminal_resize');
      if (args.sessionId !== 'resize-main') return;
      if (args.cols === 80) { firstStarted.resolve(); await release.promise; }
      sizes.push(Number(args.cols));
    });
    try {
      const first = resizeDesktopTerminal('resize-main', 80, 24);
      await firstStarted.promise;
      const last = resizeDesktopTerminal('resize-main', 120, 40);
      await resizeDesktopTerminal('resize-other', 90, 30);
      release.resolve();
      await Promise.all([first, last]);
      assert.deepEqual(sizes, [80, 120], 'the PTY must finish at the most recent requested size');
    } finally { release.resolve(); restore(); }
  });

  test(`${mode} terminal pastes preserve Unicode, input order and the backend byte limit`, async () => {
    const firstStarted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const paste = 'a'.repeat(8191) + '😀' + '汉'.repeat(10_000) + 'b'.repeat(16_000) + '🚀';
    const chunks: string[] = [];
    let firstWrite = true;
    const restore = stubTransport(mode, async (command, args) => {
      assert.equal(command, 'terminal_write');
      if (args.sessionId !== 'paste-main') return;
      if (firstWrite) { firstWrite = false; firstStarted.resolve(); await release.promise; }
      chunks.push(String(args.data));
    });
    try {
      const first = writeDesktopTerminal('paste-main', paste);
      await firstStarted.promise;
      const last = writeDesktopTerminal('paste-main', '\r');
      await writeDesktopTerminal('paste-other', 'independent');
      release.resolve();
      await Promise.all([first, last]);
      assert.ok(chunks.length > 1);
      assert.ok(chunks.every(chunk => chunk.isWellFormed() && Buffer.byteLength(chunk, 'utf8') <= 64 * 1024));
      assert.equal(chunks.join(''), paste + '\r');
    } finally { release.resolve(); restore(); }
  });

  test(`${mode} terminal resize failures do not block queued or later sizes`, async () => {
    const attempted: number[] = [];
    const restore = stubTransport(mode, async (command, args) => {
      assert.equal(command, 'terminal_resize');
      attempted.push(Number(args.cols));
      if (args.cols === 80) throw new Error('resize rejected');
    });
    try {
      const failed = assert.rejects(resizeDesktopTerminal('resize-retry', 80, 24));
      const queued = resizeDesktopTerminal('resize-retry', 120, 40);
      await Promise.all([failed, queued]);
      await resizeDesktopTerminal('resize-retry', 90, 30);
      assert.deepEqual(attempted, [80, 120, 90]);
    } finally { restore(); }
  });
}
