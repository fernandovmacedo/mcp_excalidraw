#!/usr/bin/env node
// Headless renderer checks — pure Node, no browser, no canvas server.
// Run after `npm run build:server`: node scripts/check-render.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { mixedScene, pixelFile } from '../tests/browser/fixtures.mjs';
import { renderScene, RenderError } from '../dist/core/render/index.js';
import { expandElementsForExport } from '../dist/core/expand-elements.js';
import { prepareScene } from '../dist/core/render/excalidraw-node/index.js';
import { embedPngScene, extractPngScene } from '../dist/core/png-scene.js';
import { generateKeyBetween } from 'fractional-indexing';

const failures = [];
async function check(name, fn) {
  try { await fn(); process.stdout.write(`ok   ${name}\n`); }
  catch (error) { failures.push(name); process.stdout.write(`FAIL ${name}\n     ${error.message}\n`); }
}

function pngDimensions(buffer) {
  assert.equal(buffer.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG signature');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

const serverElements = [
  ...mixedScene(),
  { id: 'virgil', type: 'text', x: 600, y: 320, text: 'Virgil here', fontSize: 20, fontFamily: 1 }
];
const scene = {
  elements: serverElements,
  files: { [pixelFile.id]: pixelFile }
};
const outDir = path.join(os.tmpdir(), 'excalidraw-check-render');
fs.mkdirSync(outDir, { recursive: true });

await check('svg: renders every element type in the fixture', async () => {
  const result = await renderScene(scene, { format: 'svg' });
  assert.ok(result.data.startsWith('<svg'), 'starts with <svg');
  assert.ok(!/<svg[^>]*xmlns="[^"]*"[^>]*xmlns=/.test(result.data), 'no duplicate xmlns attribute');
  for (const label of ['Bound label', 'Agent label', 'Hello inside frame', 'repro-frame', 'Virgil here']) {
    assert.ok(result.data.includes(label), `contains ${label}`);
  }
  assert.ok(result.data.includes('<image'), 'image element');
  assert.ok(result.data.includes('clip-path'), 'frame clip');
  assert.ok(result.data.includes('@font-face'), 'fonts embedded');
  assert.ok(result.data.includes('font-family: "Excalifont"'), 'Excalifont face');
  assert.ok(result.data.includes('font-family: "Virgil"'), 'Virgil face');
  assert.ok(result.width > 0 && result.height > 0, 'dimensions reported');
  fs.writeFileSync(path.join(outDir, 'scene.svg'), result.data);
});

await check('svg: deterministic for an unchanged scene', async () => {
  const a = await renderScene(scene, { format: 'svg' });
  const b = await renderScene(scene, { format: 'svg' });
  assert.equal(a.data, b.data);
});

await check('svg: embedFonts=false leaves the style block empty', async () => {
  const result = await renderScene(scene, { format: 'svg', embedFonts: false });
  assert.ok(!result.data.includes('@font-face'));
});

let base;
await check('png: valid file with the SVG dimensions', async () => {
  base = await renderScene(scene, { format: 'png' });
  const buffer = Buffer.from(base.data, 'base64');
  const dims = pngDimensions(buffer);
  const svg = await renderScene(scene, { format: 'svg' });
  assert.equal(dims.width, Math.round(svg.width));
  assert.equal(dims.height, Math.round(svg.height));
  assert.equal(base.width, dims.width);
  fs.writeFileSync(path.join(outDir, 'scene.png'), buffer);
});

await check('png: deterministic', async () => {
  const again = await renderScene(scene, { format: 'png' });
  assert.equal(again.data, base.data);
});

await check('png: embedded scene preserves editable labels, bindings and image files', async () => {
  const input = { ...scene, files: { ...scene.files, unused: { ...pixelFile, id: 'unused' } } };
  const result = await renderScene(input, { format: 'png', embedScene: true });
  const bytes = Buffer.from(result.data, 'base64');
  const saved = JSON.parse(extractPngScene(bytes));
  assert.equal(saved.type, 'excalidraw');
  assert.equal(saved.elements.find(el => el.id === 'label').containerId, 'shape');
  assert.equal(saved.elements.find(el => el.id === 'arrow').startBinding.elementId, 'shape');
  assert.equal(saved.elements.find(el => el.id === 'shorthand-label').text, 'Agent label');
  assert.deepEqual(saved.files, scene.files, 'only referenced image files included');
  const restored = await renderScene(saved, { format: 'png' });
  assert.equal(restored.data, base.data, 'saved scene recreates the same image');
  const again = await renderScene(input, { format: 'png', embedScene: true });
  assert.equal(again.data, result.data, 'unchanged scene produces identical committed bytes');
  assert.throws(() => extractPngScene(Buffer.from(base.data, 'base64')), /no embedded Excalidraw scene/i);
});

await check('png: selection metadata excludes unrelated elements and files', async () => {
  const result = await renderScene(scene, { format: 'png', embedScene: true, elementIds: ['shape'] });
  const saved = JSON.parse(extractPngScene(Buffer.from(result.data, 'base64')));
  assert.deepEqual(saved.elements.map(el => el.id).sort(), ['label', 'shape']);
  assert.deepEqual(saved.files, {});
});

await check('png: selected frame children reopen without their omitted frame', async () => {
  const result = await renderScene(scene, { format: 'png', embedScene: true, elementIds: ['text-repro-1'] });
  const saved = JSON.parse(extractPngScene(Buffer.from(result.data, 'base64')));
  assert.deepEqual(saved.elements.map(el => el.id), ['text-repro-1']);
  assert.equal(saved.elements[0].frameId, null);
  const reopened = await renderScene(saved, { format: 'svg' });
  assert.ok(reopened.data.includes('Hello inside frame'));
});

await check('png: elbow arrows retain endpoint editing state and fixed segments', async () => {
  const elbow = {
    id: 'native-elbow', type: 'arrow', x: 100, y: 100, width: 100, height: 60,
    elbowed: true, points: [[0, 0], [30, 0], [30, 30], [70, 30], [70, 60], [100, 60]],
    fixedSegments: [{ start: [30, 30], end: [70, 30], index: 3 }],
    startIsSpecial: true, endIsSpecial: true, startBinding: null, endBinding: null, endArrowhead: 'arrow'
  };
  const result = await renderScene({ elements: [elbow], files: {} }, { format: 'png', embedScene: true });
  const saved = JSON.parse(extractPngScene(Buffer.from(result.data, 'base64')));
  for (const element of [saved.elements[0], (await prepareScene(saved.elements))[0]]) {
    assert.equal(element.startIsSpecial, true);
    assert.equal(element.endIsSpecial, true);
    assert.deepEqual(element.fixedSegments, elbow.fixedSegments);
    assert.deepEqual(element.points, elbow.points);
    assert.deepEqual([element.x, element.y, element.width, element.height], [100, 100, 100, 60]);
  }
});

await check('png: frame metadata includes the frame and visible contents only', async () => {
  const result = await renderScene(scene, { format: 'png', embedScene: true, frameId: 'frame-repro-1' });
  const saved = JSON.parse(extractPngScene(Buffer.from(result.data, 'base64')));
  assert.deepEqual(saved.elements.map(el => el.id).sort(), ['frame-repro-1', 'text-repro-1', 'text-repro-2']);
  assert.deepEqual(saved.files, {});
});

await check('png: metadata replacement preserves Unicode and rejects damaged PNGs', async () => {
  const original = Buffer.from(base.data, 'base64');
  const oldScene = JSON.stringify({ type: 'excalidraw', elements: [], appState: {} });
  const newScene = JSON.stringify({ type: 'excalidraw', elements: [{ type: 'text', text: '流程 café → done' }] });
  const bytes = embedPngScene(embedPngScene(original, oldScene), newScene);
  assert.equal(extractPngScene(bytes), newScene);
  assert.throws(() => extractPngScene(bytes.subarray(0, bytes.length - 5)), /PNG/i);
  const damaged = Buffer.from(bytes);
  damaged[29] ^= 1; // Corrupt the IHDR checksum.
  assert.throws(() => extractPngScene(damaged), /PNG|checksum|CRC/i);
});

await check('png: scale 2 doubles the dimensions', async () => {
  const result = await renderScene(scene, { format: 'png', scale: 2 });
  const dims = pngDimensions(Buffer.from(result.data, 'base64'));
  // Scene sizes can end in .5px, so allow one pixel of rounding.
  assert.ok(Math.abs(dims.width - base.width * 2) <= 1, `width ${dims.width} vs ${base.width * 2}`);
  assert.ok(Math.abs(dims.height - base.height * 2) <= 1, `height ${dims.height} vs ${base.height * 2}`);
});

// Solid red 8x8 PNG, built here so the check needs no fixture file.
function solidPng() {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(8, 0); ihdr.writeUInt32BE(8, 4); ihdr[8] = 8; ihdr[9] = 2;
  const rows = Buffer.concat(Array.from({ length: 8 }, () => Buffer.from([0, ...Array(8).fill([255, 0, 0]).flat()])));
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

await check('png: image elements are drawn (symbol/use inlined for resvg)', async () => {
  const image = { id: 'pic', type: 'image', x: 0, y: 0, width: 60, height: 60, fileId: 'red', status: 'saved', scale: [1, 1] };
  const red = { id: 'red', mimeType: 'image/png', created: 1, dataURL: `data:image/png;base64,${solidPng().toString('base64')}` };
  const withFile = await renderScene({ elements: [image], files: { red } }, { format: 'png' });
  const withoutFile = await renderScene({ elements: [image], files: {} }, { format: 'png' });
  assert.notEqual(withFile.data, withoutFile.data, 'image pixels missing from the PNG');
});

await check('png: dark mode and transparent background change the output', async () => {
  const dark = await renderScene(scene, { format: 'png', dark: true });
  const transparent = await renderScene(scene, { format: 'png', background: false });
  assert.notEqual(dark.data, base.data);
  assert.notEqual(transparent.data, base.data);
  fs.writeFileSync(path.join(outDir, 'scene-dark.png'), Buffer.from(dark.data, 'base64'));
});

await check('png: scale is clamped to the max dimension with a warning', async () => {
  process.env.EXCALIDRAW_RENDER_MAX_DIM = '600';
  try {
    const result = await renderScene(scene, { format: 'png', scale: 4 });
    const dims = pngDimensions(Buffer.from(result.data, 'base64'));
    assert.ok(Math.max(dims.width, dims.height) <= 600, `max dim ${Math.max(dims.width, dims.height)}`);
    assert.ok(result.warnings.some(w => w.includes('scale reduced')));
  } finally {
    delete process.env.EXCALIDRAW_RENDER_MAX_DIM;
  }
});

await check('elementIds: renders only the subset plus bound text', async () => {
  const result = await renderScene(scene, { format: 'svg', elementIds: ['shape'] });
  assert.ok(result.data.includes('Bound label'));
  assert.ok(!result.data.includes('Agent label'));
  assert.ok(!result.data.includes('<image'));
});

await check('frameId: clips to the frame and drops outside elements', async () => {
  const result = await renderScene(scene, { format: 'svg', frameId: 'frame-repro-1' });
  assert.ok(result.data.includes('Hello inside frame'));
  assert.ok(!result.data.includes('Bound label'));
});

await check('non-Latin text switches to system fonts with a warning', async () => {
  const cjk = {
    elements: [{ id: 'cjk', type: 'text', x: 0, y: 0, text: '中文標籤', fontSize: 20 }],
    files: {}
  };
  const result = await renderScene(cjk, { format: 'png' });
  assert.ok(result.warnings.some(w => w.includes('system fonts')));
});

// Decode an 8-bit RGBA or RGB PNG (what resvg writes) to rows of pixels.
function decodePng(buffer) {
  const { width, height } = pngDimensions(buffer);
  const colorType = buffer[25];
  const bpp = colorType === 6 ? 4 : 3;
  const idat = [];
  for (let at = 8; at < buffer.length;) {
    const len = buffer.readUInt32BE(at);
    if (buffer.toString('latin1', at + 4, at + 8) === 'IDAT') idat.push(buffer.subarray(at + 8, at + 8 + len));
    at += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x];
      const a = x >= bpp ? out[y * stride + x - bpp] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0;
      const p = a + b - c;
      const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      out[y * stride + x] = (v + [0, a, b, (a + b) >> 1, paeth][filter]) & 0xff;
    }
  }
  return { width, height, bpp, stride, data: out };
}

// Grey levels of the first `columns` columns: where a left-aligned text's
// first glyph lands, so two lines starting with the same glyph match.
function leftBlock(png, columns) {
  const image = decodePng(Buffer.from(png.data, 'base64'));
  const grey = [];
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < columns; x++) {
      const at = y * image.stride + x * image.bpp;
      grey.push((image.data[at] + image.data[at + 1] + image.data[at + 2]) / 3);
    }
  }
  return grey;
}

function blockDistance(a, b) {
  assert.equal(a.length, b.length, 'same block size');
  return a.reduce((sum, v, i) => sum + Math.abs(v - b[i]), 0);
}

const symbolText = text => ({
  elements: [{ id: 'sym', type: 'text', x: 0, y: 0, text, fontSize: 40, fontFamily: 6 }],
  files: {}
});
// ⚠ is 0.9em wide in the symbol font: 36px at 40px, after 10px of padding.
const WARNING_COLUMNS = 10 + 34;

await check('symbols: Nunito text with ⚠ ↑ ⅓ embeds the symbol font as fallback', async () => {
  const withSymbols = symbolText('⚠ ↑ ⅓ symbols');
  const svg = await renderScene(withSymbols, { format: 'svg' });
  assert.ok(svg.data.includes('font-family: "Render Symbols"'), 'symbol @font-face embedded');
  assert.match(svg.data, /font-family="Nunito, Render Symbols, /, 'family listed after the primary one');
  const png = await renderScene(withSymbols, { format: 'png' });
  assert.ok(!png.warnings.some(w => w.includes('system fonts')), 'covered symbols need no system fonts');
});

await check('symbols: PNG draws ⚠ from the symbol font, also beside Nunito ligatures', async () => {
  const alone = leftBlock(await renderScene(symbolText('⚠'), { format: 'png' }), WARNING_COLUMNS);
  const tofu = leftBlock(await renderScene(symbolText('\uE000'), { format: 'png', systemFonts: false }), WARNING_COLUMNS);
  const tofuDistance = blockDistance(alone, tofu);
  assert.ok(tofuDistance > 0, 'a lone ⚠ draws differently from the missing-glyph box');
  // "fi" is a Nunito ligature: it used to make resvg drop the fallback. Long
  // lines may place the glyph a fraction of a pixel apart, hence the margin.
  for (const text of ['⚠ valores pontuais, sem teste de significância', '⚠ fi', '⚠ < 50% & fi']) {
    const line = leftBlock(await renderScene(symbolText(text), { format: 'png' }), WARNING_COLUMNS);
    const distance = blockDistance(line, alone);
    assert.ok(distance < tofuDistance / 5, `⚠ in "${text}" is ${distance} from a lone ⚠, the box is ${tofuDistance}`);
  }
});

await check('symbols: text without symbols leaves the symbol font out', async () => {
  const svg = await renderScene(symbolText('plain text — no symbols'), { format: 'svg' });
  assert.ok(!svg.data.includes('Render Symbols'));
});

await check('validation: bad scale, format, exclusive selectors, unknown ids', async () => {
  await assert.rejects(renderScene(scene, { format: 'png', scale: 9 }), RenderError);
  await assert.rejects(renderScene(scene, { format: 'gif' }), RenderError);
  await assert.rejects(renderScene(scene, { format: 'svg', elementIds: ['shape'], frameId: 'frame-repro-1' }), RenderError);
  await assert.rejects(renderScene(scene, { format: 'svg', elementIds: ['nope'] }), e => e instanceof RenderError && e.status === 404);
  await assert.rejects(renderScene(scene, { format: 'svg', frameId: 'shape' }), RenderError);
});

// More than 62 elements, so order keys must grow past one base-62 digit;
// the labels add bound text elements appended after every shape.
const exportSource = [
  ...Array.from({ length: 70 }, (_, i) => ({
    id: `box-${i}`, type: 'rectangle', x: (i % 10) * 200, y: Math.floor(i / 10) * 120,
    width: 160, height: 60, text: `Box ${i}`
  })),
  { id: 'note', type: 'text', x: 0, y: 900, text: 'free text\nsecond line', fontSize: 20 }
];

await check('export: order keys are valid and ascending in array order', async () => {
  const elements = expandElementsForExport(exportSource, { deterministic: true });
  const keys = elements.map(e => e.index);
  for (const key of keys) generateKeyBetween(key, null);  // throws "invalid order key"
  assert.deepEqual(keys, [...keys].sort(), 'keys sort as strings in array order');
  assert.equal(new Set(keys).size, keys.length, 'keys are unique');
});

await check('export: free text is left/top aligned, shape labels stay centred', async () => {
  const elements = expandElementsForExport(exportSource, { deterministic: true });
  const note = elements.find(e => e.id === 'note');
  assert.equal(note.textAlign, 'left');
  assert.equal(note.verticalAlign, 'top');
  const label = elements.find(e => e.id === 'box-0-label');
  assert.equal(label.textAlign, 'center');
});

await check('export: explicit roundness null keeps a rectangle square', async () => {
  const elements = expandElementsForExport([
    { id: 'square', type: 'rectangle', x: 0, y: 0, width: 40, height: 40, roundness: null },
    { id: 'rounded', type: 'rectangle', x: 60, y: 0, width: 40, height: 40 }
  ], { deterministic: true });
  assert.equal(elements.find(e => e.id === 'square').roundness, null);
  assert.deepEqual(elements.find(e => e.id === 'rounded').roundness, { type: 3 });
});

await check('export: a re-exported scene renders from its file', async () => {
  const elements = expandElementsForExport(exportSource, { deterministic: true });
  const result = await renderScene({ elements, files: {} }, { format: 'svg' });
  assert.ok(result.data.includes('Box 69'));
});

// The canvas tab runs every server scene through prepareServerScene and syncs
// the result back, so repeated passes must not move anything (#116).
await check('scene prep: repeated passes keep text and arrow geometry', async () => {
  const source = [
    { id: 'a', type: 'rectangle', x: 0, y: 0, width: 100, height: 50, label: { text: 'A' } },
    { id: 'b', type: 'rectangle', x: 300, y: 0, width: 100, height: 50 },
    { id: 'centre', type: 'text', x: 910, y: 100, text: 'Hello', textAlign: 'center', fontSize: 20 },
    { id: 'right', type: 'text', x: 910, y: 300, text: 'Mid', textAlign: 'right', verticalAlign: 'middle', fontSize: 20 },
    { id: 'up', type: 'arrow', x: 300, y: 300, width: 0, height: 40, points: [[0, 0], [0, -40]] },
    { id: 'link', type: 'arrow', x: 100, y: 25, width: 200, height: 0, points: [[0, 0], [200, 0]],
      start: { id: 'a' }, end: { id: 'b' }, label: { text: 'calls' } }
  ];
  const geometry = els => Object.fromEntries(els.map(e =>
    [e.containerId ? `label:${e.containerId}` : e.id, [e.x, e.y, e.width, e.height, JSON.stringify(e.points ?? null)]]));
  let elements = await prepareScene(source);
  const first = geometry(elements);
  for (const id of ['centre', 'right', 'up', 'link']) {
    const src = source.find(e => e.id === id);
    assert.deepEqual(first[id].slice(0, 2), [src.x, src.y], `${id} keeps the caller's x/y`);
  }
  assert.equal(first.up[3], 40, 'vertical arrow keeps its length');
  for (let i = 0; i < 3; i++) elements = await prepareScene(elements);
  assert.deepEqual(geometry(elements), first);
});

// A server update merged onto the tab's element carries the label shorthand
// and the bound text from the last conversion. Converting it again must
// replace that label, not add another one beside it.
await check('scene prep: merged label updates keep one bound label', async () => {
  const box = (x, text) => ({ id: 'box', type: 'rectangle', x, y: 0, width: 160, height: 70, label: { text } });
  let elements = await prepareScene([
    box(0, 'Hello'),
    { id: 'other', type: 'rectangle', x: 400, y: 0, width: 100, height: 70 },
    { id: 'edge', type: 'arrow', x: 160, y: 35, width: 240, height: 0, points: [[0, 0], [240, 0]],
      start: { id: 'box' }, end: { id: 'other' } }
  ]);
  for (const incoming of [box(10, 'Hello'), box(20, 'Hello'), box(30, 'Renamed')]) {
    // The tab's incremental merge (App.tsx): { ...local, ...incoming }
    elements = await prepareScene(elements.map(e => e.id === incoming.id ? { ...e, ...incoming } : e));
  }
  const labels = elements.filter(e => e.type === 'text');
  assert.deepEqual(labels.map(e => [e.id, e.containerId, e.text]), [['box-label', 'box', 'Renamed']]);
  const bindings = elements.find(e => e.id === 'box').boundElements.map(b => `${b.type}:${b.id}`).sort();
  assert.deepEqual(bindings, ['arrow:edge', 'text:box-label']);
});

// Free text's x/width is its box; textAlign places the lines inside it. A
// stored width the renderer measures differently must not move the lines.
await check('scene prep: free text keeps its lines where textAlign puts them in its box', async () => {
  const text = (id, textAlign, y) => ({ id, type: 'text', x: 100, y, width: 200, height: 50,
    text: 'Hello world\nHi', originalText: 'Hello world\nHi', fontSize: 20, fontFamily: 5,
    textAlign, verticalAlign: 'top', containerId: null, autoResize: true, lineHeight: 1.25 });
  const source = expandElementsForExport([
    { id: 'origin', type: 'rectangle', x: 0, y: 0, width: 10, height: 10 },
    text('left', 'left', 100), text('centre', 'center', 200), text('right', 'right', 300),
    { id: 'box', type: 'rectangle', x: 400, y: 0, width: 160, height: 70, label: { text: 'Label' } }
  ], { deterministic: true });
  const share = { left: 0, centre: 0.5, right: 1 };
  const prepared = await prepareScene(source);
  for (const [id, s] of Object.entries(share)) {
    const el = prepared.find(e => e.id === id);
    assert.ok(el.width < 150, `${id} is re-measured`);
    assert.ok(Math.abs(el.x + el.width * s - (100 + 200 * s)) < 0.01, `${id} line anchor stays at ${100 + 200 * s}`);
  }
  const label = prepared.find(e => e.containerId === 'box');
  assert.ok(Math.abs(label.x + label.width / 2 - 480) < 0.01, 'shape label stays centred');

  // Each line is drawn at translate + text x: the box's left, centre or right.
  const { data: svg } = await renderScene({ elements: source, files: {} }, { format: 'svg', padding: 0, embedFonts: false });
  const groups = [...svg.matchAll(/<g transform="translate\(([\d.-]+) ([\d.-]+)\)[^"]*">((?:<text [^>]*>[^<]*<\/text>)+)/g)];
  for (const [y, s] of [[100, 0], [200, 0.5], [300, 1]]) {
    const g = groups.find(m => Number(m[2]) === y);
    assert.ok(g, `text group at y=${y}`);
    const xs = [...g[3].matchAll(/<text x="([\d.-]+)"/g)].map(m => Number(g[1]) + Number(m[1]));
    assert.equal(xs.length, 2, 'two lines');
    for (const x of xs) assert.ok(Math.abs(x - (100 + 200 * s)) < 0.01, `line at ${x}, expected ${100 + 200 * s}`);
  }
});

// Excalidraw's SVG exporter masks a hole exactly the label's size behind an
// arrow label; the editor clears the label box plus BOUND_TEXT_PADDING (5 px)
// on each side, so the line stops short of the letters. The render matches it.
await check('svg: arrow label hole keeps the editor\'s 5 px gap around the text', async () => {
  for (const strokeStyle of ['dashed', 'solid']) {
    const elements = [
      { id: 'gap-arrow', type: 'arrow', x: 0, y: 0, width: 400, height: 0, strokeStyle,
        points: [[0, 0], [400, 0]], boundElements: [{ id: 'gap-label', type: 'text' }] },
      { id: 'gap-label', type: 'text', x: 0, y: 0, text: 'não continua', originalText: 'não continua',
        fontSize: 20, fontFamily: 5, containerId: 'gap-arrow', textAlign: 'center', verticalAlign: 'middle' }
    ];
    const label = (await prepareScene(elements)).find(el => el.id === 'gap-label');
    const svg = (await renderScene({ elements, files: {} }, { format: 'svg', padding: 0 })).data;
    const mask = svg.match(/<mask id="mask-gap-arrow">([\s\S]*?)<\/mask>/)?.[1];
    assert.ok(mask, `${strokeStyle}: arrow has a label mask`);
    const hole = mask.match(/<rect x="([-\d.]+)" y="([-\d.]+)" fill="#000" width="([\d.]+)" height="([\d.]+)"/);
    assert.ok(hole, `${strokeStyle}: mask has a hole`);
    assert.ok(Math.abs(Number(hole[3]) - (label.width + 10)) < 0.01, `${strokeStyle}: hole width ${hole[3]} = label ${label.width} + 10`);
    assert.ok(Math.abs(Number(hole[4]) - (label.height + 10)) < 0.01, `${strokeStyle}: hole height ${hole[4]} = label ${label.height} + 10`);
  }
});

await check('render time: warm render under 500 ms', async () => {
  const t0 = performance.now();
  await renderScene(scene, { format: 'png' });
  const ms = performance.now() - t0;
  assert.ok(ms < 500, `${ms.toFixed(0)} ms`);
});

process.stdout.write(`\noutputs: ${outDir}\n`);
if (failures.length > 0) {
  process.stdout.write(`\n${failures.length} check(s) failed\n`);
  process.exit(1);
}
process.stdout.write('\nAll headless renderer checks passed\n');
