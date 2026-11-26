import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownRenderer } from "../src/components/MarkdownRenderer.tsx";
import { StreamingMarkdownCache } from "../src/services/streamingMarkdown.ts";
import { segmentMarkdownImageStacks } from "../src/services/markdownImageStack.ts";

const segment = (content: string, streaming = false) => {
  const cache = new StreamingMarkdownCache();
  const { blocks, html } = cache.renderBlocks(content, streaming);
  return segmentMarkdownImageStacks(blocks, html);
};

const render = (content: string, streaming = false) =>
  renderToStaticMarkup(createElement(MarkdownRenderer, {
    content,
    isStreaming: streaming,
    streamingCursor: streaming,
  }));

test("two or fewer images do not trigger image stacking", () => {
  assert.equal(segment("Just text without images."), null);
  assert.equal(segment("![One](one.png)"), null);
  assert.equal(segment("![One](one.png)\n\n![Two](two.png)"), null);
  assert.equal(segment("![One](one.png)\n![Two](two.png)"), null);
  assert.equal(segment("![One](one.png) ![Two](two.png)"), null);

  const html = render("![One](one.png)\n\n![Two](two.png)");
  assert.equal(html.includes("markdown-image-stack"), false);
});

test("three or more consecutive images across paragraphs stack together", () => {
  const segments = segment(
    "Intro paragraph.\n\n![First](a.png)\n\n![Second](b.png)\n\n![Third](c.png)\n\nOutro paragraph."
  );
  assert.ok(segments);
  assert.equal(segments.length, 3);
  assert.equal(segments[0].type, "html");
  assert.ok(segments[0].html.includes("Intro paragraph."));
  assert.equal(segments[1].type, "image-stack");
  assert.deepEqual(
    segments[1].images.map(img => [img.alt, img.workspacePath]),
    [["First", "a.png"], ["Second", "b.png"], ["Third", "c.png"]],
  );
  assert.equal(segments[2].type, "html");
  assert.ok(segments[2].html.includes("Outro paragraph."));
});

test("three or more images in one paragraph stack while preserving leading and trailing prose", () => {
  const segments = segment(
    "以下是截图：\n![一](1.png)\n![二](2.png)\n![三](3.png)\n![四](4.png)\n以上是全部内容。"
  );
  assert.ok(segments);
  assert.equal(segments.length, 3);
  assert.equal(segments[0].type, "html");
  assert.equal(segments[0].html, "<p>以下是截图：</p>");
  assert.equal(segments[1].type, "image-stack");
  assert.equal(segments[1].images.length, 4);
  assert.equal(segments[2].type, "html");
  assert.equal(segments[2].html, "<p>以上是全部内容。</p>");
});

test("mixed single-paragraph and next-paragraph images merge when total exceeds two", () => {
  const segments = segment("说明：\n![A](a.png) ![B](b.png)\n\n![C](c.png)");
  assert.ok(segments);
  assert.equal(segments.length, 2);
  assert.equal(segments[0].type, "html");
  assert.equal(segments[0].html, "<p>说明：</p>");
  assert.equal(segments[1].type, "image-stack");
  assert.deepEqual(segments[1].images.map(img => img.alt), ["A", "B", "C"]);
});

test("raw HTML consecutive img tags and image-only lists stack when count exceeds two", () => {
  const rawSegments = segment(
    '<img src="https://example.com/1.png" alt="One">\n<img src="https://example.com/2.png" alt="Two">\n<img src="https://example.com/3.png" alt="Three">'
  );
  assert.ok(rawSegments);
  assert.equal(rawSegments.length, 1);
  assert.equal(rawSegments[0].type, "image-stack");
  assert.deepEqual(rawSegments[0].images.map(img => img.src), [
    "https://example.com/1.png",
    "https://example.com/2.png",
    "https://example.com/3.png",
  ]);

  const listSegments = segment("- ![A](a.png)\n- ![B](b.png)\n- ![C](c.png)");
  assert.ok(listSegments);
  assert.equal(listSegments.length, 1);
  assert.equal(listSegments[0].type, "image-stack");
  assert.deepEqual(listSegments[0].images.map(img => img.alt), ["A", "B", "C"]);
});

test("images separated by prose remain in their respective sections", () => {
  const segments = segment("Section 1\n\n![A](a.png)\n\nSection 2\n\n![B](b.png)\n\nSection 3\n\n![C](c.png)");
  assert.equal(segments, null);
});

test("SSR renders accessible stacked cards and keeps streaming cursor intact", () => {
  const html = render("![First](a.png)\n\n![Second](b.png)\n\n![Third](c.png)", true);
  assert.ok(html.includes('class="markdown-image-stack"'));
  assert.ok(html.includes('data-count="3"'));
  assert.ok(html.includes('data-workspace-path="a.png"'));
  assert.ok(html.includes('data-workspace-path="b.png"'));
  assert.ok(html.includes('data-workspace-path="c.png"'));
  assert.ok(html.includes('class="thinking-streaming-cursor"'));
});

test("safe inline base64 raster images stack together when count exceeds two", () => {
  const px = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
  const segments = segment(`![A](${px})\n![B](${px})\n![C](${px})`);
  assert.ok(segments);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].type, "image-stack");
  assert.equal(segments[0].images.length, 3);
  assert.ok(segments[0].images.every(img => img.src === px));
});
