import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  extractDroppedFiles,
  getFirstDroppedFile,
  hasDraggedFiles,
  installWindowFileDropGuard,
} from '../src/utils/fileDrop.ts';
import { ComposerDrafts } from '../src/services/composerDrafts.ts';
import {
  computePerImageBase64Budget,
  computeScaledDimensions,
  extractBase64FromDataUrl,
  prepareVisionImageAttachment,
} from '../src/utils/imageCompress.ts';
import {
  downloadImage,
  openImageInNewWindow,
  saveImageAs,
  suggestImageFilename,
} from '../src/services/imageActions.ts';
import {
  registerImageBlobUrl,
  unregisterImageBlobUrl,
} from '../src/services/originalImagePreview.ts';

test('hasDraggedFiles detects Files type, file items, and FileList entries while ignoring text drags', () => {
  assert.equal(hasDraggedFiles(null), false);
  assert.equal(hasDraggedFiles(undefined), false);
  assert.equal(hasDraggedFiles({ types: ['text/plain', 'text/html'] }), false);
  assert.equal(hasDraggedFiles({ types: ['Files'] }), true);
  // Array-like DOMStringList compatibility (WebKit)
  assert.equal(hasDraggedFiles({ types: { 0: 'public.file-url', 1: 'Files', length: 2 } }), true);
  assert.equal(hasDraggedFiles({ types: [], items: [{ kind: 'string' }] }), false);
  assert.equal(hasDraggedFiles({ types: [], items: [{ kind: 'file' }] }), true);
  const fakeFile = new File(['hello'], 'notes.txt', { type: 'text/plain' });
  assert.equal(hasDraggedFiles({ types: [], files: [fakeFile] }), true);
});

test('getFirstDroppedFile prefers dataTransfer.files and falls back to file DataTransferItems', () => {
  const fileA = new File(['a'], 'a.png', { type: 'image/png' });
  const fileB = new File(['b'], 'b.txt', { type: 'text/plain' });
  assert.equal(getFirstDroppedFile(null), null);
  assert.equal(getFirstDroppedFile({ files: [fileA, fileB] }), fileA);
  assert.equal(
    getFirstDroppedFile({
      files: [],
      items: [
        { kind: 'string', getAsFile: () => null },
        { kind: 'file', getAsFile: () => fileB },
      ],
    }),
    fileB,
  );
  assert.equal(
    getFirstDroppedFile({
      files: [],
      items: [{ kind: 'string', getAsFile: () => fileA }],
    }),
    null,
  );

  // Directory entries are skipped and reported separately while multiple files are preserved.
  const folderStub = new File([], 'folder');
  const extracted = extractDroppedFiles({
    files: [folderStub, fileA, fileB],
    items: [
      { kind: 'file', getAsFile: () => folderStub, webkitGetAsEntry: () => ({ isDirectory: true }) },
      { kind: 'file', getAsFile: () => fileA, webkitGetAsEntry: () => ({ isDirectory: false, isFile: true }) },
      { kind: 'file', getAsFile: () => fileB, webkitGetAsEntry: () => ({ isDirectory: false, isFile: true }) },
    ],
  });
  assert.equal(extracted.skippedDirectories, 1);
  assert.deepEqual(extracted.files, [fileA, fileB]);
});

test('installWindowFileDropGuard prevents default file navigation outside drop zones without blocking handled or text drags', () => {
  const listeners = new Map<string, (event: unknown) => void>();
  const fakeWindow = {
    addEventListener(type: string, fn: (event: unknown) => void) {
      listeners.set(type, fn);
    },
    removeEventListener(type: string) {
      listeners.delete(type);
    },
  };

  const cleanup = installWindowFileDropGuard(fakeWindow as unknown as Window);
  assert.ok(listeners.has('dragover'));
  assert.ok(listeners.has('drop'));

  // Unhandled file dragover outside composer: prevented and dropEffect set to none.
  const fileDragOver = {
    defaultPrevented: false,
    dataTransfer: { types: ['Files'], dropEffect: 'copy' as DataTransfer['dropEffect'] },
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
  listeners.get('dragover')!(fileDragOver);
  assert.equal(fileDragOver.defaultPrevented, true);
  assert.equal(fileDragOver.dataTransfer.dropEffect, 'none');

  // Unhandled file drop outside composer: prevented so WebView does not navigate.
  const fileDrop = {
    defaultPrevented: false,
    dataTransfer: { types: ['Files'] },
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
  listeners.get('drop')!(fileDrop);
  assert.equal(fileDrop.defaultPrevented, true);

  // Already-handled composer dragover: left untouched (keeps dropEffect = copy).
  const handledDragOver = {
    defaultPrevented: true,
    dataTransfer: { types: ['Files'], dropEffect: 'copy' as DataTransfer['dropEffect'] },
    preventDefault() {
      throw new Error('should not call preventDefault again');
    },
  };
  listeners.get('dragover')!(handledDragOver);
  assert.equal(handledDragOver.dataTransfer.dropEffect, 'copy');

  // Plain text drag: ignored so text selection dragging still works.
  const textDragOver = {
    defaultPrevented: false,
    dataTransfer: { types: ['text/plain'], dropEffect: 'move' as DataTransfer['dropEffect'] },
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
  listeners.get('dragover')!(textDragOver);
  assert.equal(textDragOver.defaultPrevented, false);
  assert.equal(textDragOver.dataTransfer.dropEffect, 'move');

  cleanup();
  assert.equal(listeners.size, 0);
});

test('ComposerDrafts persists attachments per draft key across composer unmounts and notifies subscribers', () => {
  const drafts = new ComposerDrafts();
  let notifications = 0;
  const unsubscribe = drafts.subscribe(() => {
    notifications += 1;
  });

  const fileA = new File(['png-bytes'], 'diagram.png', { type: 'image/png' });
  const fileB = new File(['pdf-bytes'], 'spec.pdf', { type: 'application/pdf' });
  const attachmentA = { file: fileA, imagePreview: 'data:image/png;base64,cG5n', attachmentId: 'att-a' };
  const attachmentB = { file: fileB, imagePreview: null, attachmentId: 'att-b' };

  assert.equal(drafts.attachment('repo-a'), null);

  // Clearing an absent attachment does not fire spurious notifications.
  drafts.clearAttachment('repo-a');
  assert.equal(notifications, 0);

  drafts.setAttachment('repo-a', attachmentA);
  drafts.setAttachment('repo-b', attachmentB);
  assert.equal(notifications, 2);
  assert.equal(drafts.attachment('repo-a'), attachmentA);
  assert.equal(drafts.attachment('repo-b'), attachmentB);

  drafts.clearAttachment('repo-a');
  assert.equal(notifications, 3);
  assert.equal(drafts.attachment('repo-a'), null);
  assert.equal(drafts.attachment('repo-b'), attachmentB);

  unsubscribe();
  drafts.clearAttachment('repo-b');
  assert.equal(notifications, 3);
  assert.equal(drafts.attachment('repo-b'), null);

  // Multi-attachment add/update/move/remove lifecycle.
  drafts.addAttachments('unbound', [attachmentA, attachmentB]);
  assert.equal(drafts.attachments('unbound').length, 2);
  drafts.updateAttachment('unbound', 'att-b', { uploadedPath: '/data/attachment-inputs/id/spec.pdf' });
  assert.equal(drafts.attachments('unbound')[1].uploadedPath, '/data/attachment-inputs/id/spec.pdf');
  drafts.moveAttachments('unbound', 'bound');
  assert.equal(drafts.attachments('unbound').length, 0);
  assert.equal(drafts.attachments('bound').length, 2);
  const removed = drafts.removeAttachment('bound', 'att-b');
  assert.equal(removed?.uploadedPath, '/data/attachment-inputs/id/spec.pdf');
  assert.deepEqual(drafts.attachments('bound'), [attachmentA]);
});

test('computeScaledDimensions scales oversized images proportionally and never upscales small ones', () => {
  assert.deepEqual(computeScaledDimensions(800, 600, 2000, 2000), { width: 800, height: 600, scaled: false });
  assert.deepEqual(computeScaledDimensions(5120, 2880, 2000, 2000), { width: 2000, height: 1125, scaled: true });
  assert.deepEqual(computeScaledDimensions(1500, 3000, 2000, 2000), { width: 1000, height: 2000, scaled: true });
  assert.equal(extractBase64FromDataUrl('data:image/png;base64,QUJD'), 'QUJD');
  assert.equal(extractBase64FromDataUrl('QUJD'), 'QUJD');
});

test('computePerImageBase64Budget balances multi-image turns inside total turn cap', () => {
  // 1-5 images each get the full single-image cap (4.5M).
  assert.equal(computePerImageBase64Budget(24_000_000, 1), 4_500_000);
  assert.equal(computePerImageBase64Budget(24_000_000, 5), 4_500_000);
  // 10 images split the 24M budget evenly so all 10 fit instead of failing at #6.
  assert.equal(computePerImageBase64Budget(24_000_000, 10), 2_400_000);
  // If earlier images compressed tiny, later images reclaim remaining budget.
  assert.equal(computePerImageBase64Budget(23_500_000, 5), 4_500_000);
  assert.equal(computePerImageBase64Budget(0, 3), 0);
});

test('prepareVisionImageAttachment preserves small images and compresses oversized ones with binary quality search', async () => {
  const host = globalThis as Record<string, unknown>;
  const prevImage = host.Image;
  const prevDocument = host.document;

  const tinyFile = new File(['abc'], 'small.png', { type: 'image/png' });
  const tinyResult = await prepareVisionImageAttachment(
    tinyFile,
    'image/png',
    'data:image/png;base64,YWJj',
    { maxBase64Bytes: 100 },
  );
  assert.equal(tinyResult.mimeType, 'image/png');
  assert.equal(tinyResult.data, 'YWJj');
  assert.equal(tinyResult.compressed, false);

  // Simulate an oversized 5K PNG whose WebP encoder is unavailable (like older
  // WKWebView returning PNG), verifying progressive downscaling, single draw on
  // the final target canvas across quality probes, binary search picking higher
  // quality than coarse stepping, and prompt canvas release.
  const canvasCalls: Array<{ width: number; height: number; mimeType: string; quality?: number }> = [];
  const finalCanvasDraws: number[] = [];
  let createdCanvases: Array<{ width: number; height: number; draws: number }> = [];
  class FakeImage {
    naturalWidth = 5120;
    naturalHeight = 2880;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(_value: string) {
      queueMicrotask(() => this.onload?.());
    }
  }
  const fakeDocument = {
    createElement(tag: string) {
      assert.equal(tag, 'canvas');
      const canvas = {
        width: 0,
        height: 0,
        draws: 0,
        getContext() {
          return {
            fillStyle: '',
            globalCompositeOperation: 'source-over',
            imageSmoothingEnabled: false,
            imageSmoothingQuality: 'low',
            fillRect() {},
            drawImage() {
              canvas.draws += 1;
            },
          };
        },
        toDataURL(mimeType: string, quality?: number) {
          canvasCalls.push({ width: this.width, height: this.height, mimeType, quality });
          if (this.width === 2000 && this.height === 1125) {
            finalCanvasDraws.push(this.draws);
          }
          // Simulate WebKit falling back to PNG when asked for WebP.
          if (mimeType === 'image/png' || mimeType === 'image/webp') {
            return `data:image/png;base64,${'P'.repeat(2000)}`;
          }
          // Monotonic size with quality: q <= 0.82 fits within 800 bytes.
          const q = quality ?? 0.92;
          const len = q <= 0.82 ? Math.round(q * 900) : 1200;
          return `data:image/jpeg;base64,${'J'.repeat(len)}`;
        },
      };
      createdCanvases.push(canvas);
      return canvas;
    },
  };

  try {
    host.Image = FakeImage;
    host.document = fakeDocument;
    const hugeBase64 = 'X'.repeat(5000);
    const hugeFile = new File(['huge'], 'retina.png', { type: 'image/png' });
    const compressed = await prepareVisionImageAttachment(
      hugeFile,
      'image/png',
      `data:image/png;base64,${hugeBase64}`,
      { maxWidth: 2000, maxHeight: 2000, maxBase64Bytes: 800 },
    );
    assert.equal(compressed.mimeType, 'image/jpeg');
    assert.equal(compressed.compressed, true);
    assert.equal(compressed.width, 2000);
    assert.equal(compressed.height, 1125);
    assert.ok(compressed.data.length <= 800);
    // Binary search should find a quality > 0.75 (around 0.78-0.82) rather than settling for 0.75.
    assert.ok(compressed.data.length > 680, `expected binary search to find higher quality, got ${compressed.data.length}`);
    assert.equal(canvasCalls[0].width, 2000);
    assert.equal(canvasCalls[0].height, 1125);
    assert.ok(finalCanvasDraws.every(draws => draws === 1), 'must draw once on target canvas across all quality probes');
    assert.ok(createdCanvases.every(c => c.width === 0 && c.height === 0), 'all canvases must be released after encoding');

    // When even the smallest encoded output still exceeds the byte budget, fail explicitly.
    await assert.rejects(
      () => prepareVisionImageAttachment(
        hugeFile,
        'image/png',
        `data:image/png;base64,${hugeBase64}`,
        { maxWidth: 2000, maxHeight: 2000, maxBase64Bytes: 100 },
      ),
      /maximum supported size/i,
    );
  } finally {
    if (prevImage === undefined) delete host.Image;
    else host.Image = prevImage;
    if (prevDocument === undefined) delete host.document;
    else host.document = prevDocument;
  }
});

test('prepareVisionImageAttachment prefers WebP when supported, preserves compact PNGs, optimizes bloated PNGs, and picks dark matte for light transparent foregrounds', async () => {
  const host = globalThis as Record<string, unknown>;
  const prevImage = host.Image;
  const prevDocument = host.document;

  try {
    // 1. WebP preferred over JPEG when supported by canvas encoder.
    class Fake4KImage {
      naturalWidth = 3840;
      naturalHeight = 2160;
      onload: (() => void) | null = null;
      set src(_v: string) { queueMicrotask(() => this.onload?.()); }
    }
    host.Image = Fake4KImage;
    host.document = {
      createElement() {
        return {
          width: 0,
          height: 0,
          getContext() {
            return {
              fillStyle: '',
              globalCompositeOperation: 'source-over',
              imageSmoothingEnabled: true,
              imageSmoothingQuality: 'high',
              fillRect() {},
              drawImage() {},
            };
          },
          toDataURL(mimeType: string) {
            if (mimeType === 'image/png') return `data:image/png;base64,${'P'.repeat(2500)}`;
            if (mimeType === 'image/webp') return `data:image/webp;base64,${'W'.repeat(500)}`;
            return `data:image/jpeg;base64,${'J'.repeat(700)}`;
          },
        };
      },
    };
    const webpChoice = await prepareVisionImageAttachment(
      new File(['4k'], 'ui.png', { type: 'image/png' }),
      'image/png',
      `data:image/png;base64,${'X'.repeat(4000)}`,
      { maxWidth: 2000, maxHeight: 2000, maxBase64Bytes: 1000, softTargetBase64Bytes: 600 },
    );
    assert.equal(webpChoice.mimeType, 'image/webp');
    assert.equal(webpChoice.compressed, true);

    // 2. Compact downscaled PNG (<= softTarget) stays lossless PNG.
    host.document = {
      createElement() {
        return {
          width: 0,
          height: 0,
          getContext() {
            return {
              fillStyle: '',
              globalCompositeOperation: 'source-over',
              imageSmoothingEnabled: true,
              imageSmoothingQuality: 'high',
              fillRect() {},
              drawImage() {},
            };
          },
          toDataURL(mimeType: string) {
            if (mimeType === 'image/png') return `data:image/png;base64,${'P'.repeat(400)}`;
            return `data:image/webp;base64,${'W'.repeat(350)}`;
          },
        };
      },
    };
    const losslessChoice = await prepareVisionImageAttachment(
      new File(['diagram'], 'diagram.png', { type: 'image/png' }),
      'image/png',
      `data:image/png;base64,${'X'.repeat(4000)}`,
      { maxWidth: 2000, maxHeight: 2000, maxBase64Bytes: 1000, softTargetBase64Bytes: 600 },
    );
    assert.equal(losslessChoice.mimeType, 'image/png');
    assert.equal(losslessChoice.compressed, true);

    // 3. Bloated within-dimension PNG (> softTarget, <= maxBase64Bytes) gets
    //    opportunistically optimized at full resolution when >= 35% smaller,
    //    while an already-compact JPEG that doesn't shrink >= 35% stays untouched.
    class Fake1080pImage {
      naturalWidth = 1920;
      naturalHeight = 1080;
      onload: (() => void) | null = null;
      set src(_v: string) { queueMicrotask(() => this.onload?.()); }
    }
    host.Image = Fake1080pImage;
    host.document = {
      createElement() {
        return {
          width: 0,
          height: 0,
          getContext() {
            return {
              fillStyle: '',
              globalCompositeOperation: 'source-over',
              imageSmoothingEnabled: true,
              imageSmoothingQuality: 'high',
              fillRect() {},
              drawImage() {},
            };
          },
          toDataURL(mimeType: string) {
            if (mimeType === 'image/webp') return `data:image/webp;base64,${'W'.repeat(1200)}`;
            return `data:image/jpeg;base64,${'J'.repeat(1500)}`;
          },
        };
      },
    };
    const bloatedPng = await prepareVisionImageAttachment(
      new File(['bloated'], 'shot.png', { type: 'image/png' }),
      'image/png',
      `data:image/png;base64,${'X'.repeat(3000)}`,
      { maxWidth: 2000, maxHeight: 2000, maxBase64Bytes: 4500, softTargetBase64Bytes: 1500 },
    );
    assert.equal(bloatedPng.mimeType, 'image/webp');
    assert.equal(bloatedPng.compressed, true);
    assert.equal(bloatedPng.width, 1920);
    assert.equal(bloatedPng.height, 1080);

    const alreadyCompactJpeg = await prepareVisionImageAttachment(
      new File(['photo'], 'photo.jpg', { type: 'image/jpeg' }),
      'image/jpeg',
      `data:image/jpeg;base64,${'X'.repeat(1800)}`,
      { maxWidth: 2000, maxHeight: 2000, maxBase64Bytes: 4500, softTargetBase64Bytes: 1500 },
    );
    // 1200 / 1800 = 0.667 > 0.65 -> not enough savings, keep original untouched!
    assert.equal(alreadyCompactJpeg.mimeType, 'image/jpeg');
    assert.equal(alreadyCompactJpeg.compressed, false);
    assert.equal(alreadyCompactJpeg.data.length, 1800);

    // 4. White foreground on transparent PNG selects dark #1e1e1e JPEG matte.
    const mattesUsed: string[] = [];
    host.Image = Fake4KImage;
    host.document = {
      createElement() {
        return {
          width: 0,
          height: 0,
          getContext() {
            const ctx = {
              fillStyle: '',
              globalCompositeOperation: 'source-over',
              imageSmoothingEnabled: true,
              imageSmoothingQuality: 'high',
              fillRect() {
                if (ctx.globalCompositeOperation === 'destination-over') {
                  mattesUsed.push(ctx.fillStyle);
                }
              },
              drawImage() {},
              getImageData() {
                // Half transparent, half pure white (255, 255, 255, 255).
                return { data: new Uint8ClampedArray([0, 0, 0, 0, 255, 255, 255, 255]) };
              },
            };
            return ctx;
          },
          toDataURL(mimeType: string) {
            if (mimeType === 'image/png' || mimeType === 'image/webp') {
              return `data:image/png;base64,${'P'.repeat(2500)}`;
            }
            return `data:image/jpeg;base64,${'J'.repeat(400)}`;
          },
        };
      },
    };
    const darkMatteResult = await prepareVisionImageAttachment(
      new File(['white-icon'], 'icon.png', { type: 'image/png' }),
      'image/png',
      `data:image/png;base64,${'X'.repeat(4000)}`,
      { maxWidth: 2000, maxHeight: 2000, maxBase64Bytes: 1000 },
    );
    assert.equal(darkMatteResult.mimeType, 'image/jpeg');
    assert.equal(mattesUsed[0], '#1e1e1e');
  } finally {
    if (prevImage === undefined) delete host.Image;
    else host.Image = prevImage;
    if (prevDocument === undefined) delete host.document;
    else host.document = prevDocument;
  }
});

test('imageActions suggests clean filenames and delegates download/save-as/open to Tauri desktop commands', async () => {
  assert.equal(
    suggestImageFilename({ workspacePath: 'artifacts/screenshots/01-main-menu.png', mimeType: 'image/png' }),
    '01-main-menu.png',
  );
  assert.equal(
    suggestImageFilename({ name: 'chart.png', mimeType: 'image/webp' }),
    'chart.webp',
  );
  assert.equal(
    suggestImageFilename({ alt: 'Diagram: Overview', mimeType: 'image/jpeg' }),
    'Diagram Overview.jpg',
  );
  assert.equal(
    suggestImageFilename({ mimeType: 'image/png' }),
    'image.png',
  );

  const host = globalThis as Record<string, unknown>;
  const prevTauri = host.__TAURI_INTERNALS__;
  const prevFetch = host.fetch;
  const prevNavigator = Object.getOwnPropertyDescriptor(host, 'navigator');
  const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  try {
    host.__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, args });
        return cmd === 'save_desktop_image' ? '/Users/test/Downloads/shot.png' : undefined;
      },
    };
    host.fetch = async () => new Response(pngBytes, { headers: { 'Content-Type': 'image/png' } });
    Object.defineProperty(host, 'navigator', {
      configurable: true,
      value: { platform: 'MacIntel', userAgent: 'Macintosh' },
    });

    await downloadImage({ src: 'blob:http://127.0.0.1/shot', workspacePath: 'artifacts/shot.png' });
    await saveImageAs({ src: 'blob:http://127.0.0.1/shot', workspacePath: 'artifacts/shot.png' });
    await openImageInNewWindow({ src: 'blob:http://127.0.0.1/shot', workspacePath: 'artifacts/shot.png' });

    assert.equal(calls.length, 3);
    assert.deepEqual(calls[0], {
      cmd: 'save_desktop_image',
      args: { dataBase64: 'iVBORw0KGgo=', filename: 'shot.png', prompt: false },
    });
    assert.deepEqual(calls[1], {
      cmd: 'save_desktop_image',
      args: { dataBase64: 'iVBORw0KGgo=', filename: 'shot.png', prompt: true },
    });
    assert.deepEqual(calls[2], {
      cmd: 'open_desktop_image',
      args: { dataBase64: 'iVBORw0KGgo=', filename: 'shot.png' },
    });

    // Data URLs and registered blob URLs must succeed even when fetch() is blocked by CSP or WebKit quirks.
    host.fetch = async () => {
      throw new TypeError('Load failed');
    };
    const registeredUrl = 'blob:tauri://localhost/registered-shot';
    registerImageBlobUrl(registeredUrl, new Blob([pngBytes], { type: 'image/png' }));
    try {
      await downloadImage({ src: 'data:image/png;base64,iVBORw0KGgo=', name: 'inline.png' });
      await openImageInNewWindow({ src: registeredUrl, workspacePath: 'plots/chart.png' });
    } finally {
      unregisterImageBlobUrl(registeredUrl);
    }

    assert.equal(calls.length, 5);
    assert.deepEqual(calls[3], {
      cmd: 'save_desktop_image',
      args: { dataBase64: 'iVBORw0KGgo=', filename: 'inline.png', prompt: false },
    });
    assert.deepEqual(calls[4], {
      cmd: 'open_desktop_image',
      args: { dataBase64: 'iVBORw0KGgo=', filename: 'chart.png' },
    });
  } finally {
    if (prevTauri === undefined) delete host.__TAURI_INTERNALS__;
    else host.__TAURI_INTERNALS__ = prevTauri;
    if (prevFetch === undefined) delete host.fetch;
    else host.fetch = prevFetch;
    if (prevNavigator) Object.defineProperty(host, 'navigator', prevNavigator);
  }
});
