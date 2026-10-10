import { loadExcalidrawNode, getDomWindow } from './dom.js';
import { fnv1a } from '../../expand-elements.js';

// Render a scene to SVG with Excalidraw's own exporter running under jsdom.

export interface ExcalidrawSvgOptions {
  background: boolean;
  viewBackgroundColor: string;
  dark: boolean;
  padding: number;
  exportingFrame?: Record<string, any> | null;
}

const SERVER_ONLY_KEYS = ['createdAt', 'updatedAt', 'syncedAt', 'source', 'syncTimestamp'];

// Seeds drive roughjs's hand-drawn jitter. Server elements usually carry
// none, and Excalidraw would pick random ones — derive them from the id so
// an unchanged scene renders byte-identically.
function withDeterministicSeeds(element: Record<string, any>): Record<string, any> {
  const seeded = { ...element };
  for (const key of SERVER_ONLY_KEYS) delete seeded[key];
  if (typeof seeded.seed !== 'number') seeded.seed = (fnv1a(`${seeded.id}:seed`) % 2147483646) + 1;
  if (typeof seeded.versionNonce !== 'number') seeded.versionNonce = (fnv1a(`${seeded.id}:nonce`) % 2147483646) + 1;
  return seeded;
}

// Turn canvas-server elements (agent shorthand like label/start/end) or
// native Excalidraw elements into the scene the canvas tab would display.
// This is the tab's own preparation code (frontend/src/utils/scene.ts:
// convertToExcalidrawElements + bound-text centering + restore), bundled in,
// so headless renders match what the user sees.
export async function prepareScene(elements: Record<string, any>[]): Promise<Record<string, any>[]> {
  const mod = await loadExcalidrawNode();
  return mod.prepareServerScene(elements.map(withDeterministicSeeds));
}

export async function serializeSceneForPng(
  elements: Record<string, any>[],
  files: Record<string, any>,
  appState: Record<string, any>,
  exportingFrame: Record<string, any> | null,
  sourceElements: Record<string, any>[]
): Promise<string> {
  const mod = await loadExcalidrawNode();
  // Match Excalidraw's frame export, including ungrouped overlapping elements.
  const scoped = exportingFrame
    ? mod.elementsOverlappingBBox({ elements, bounds: exportingFrame, type: 'overlap' })
      .filter(el => !el.frameId || el.frameId === exportingFrame.id)
    : elements;
  // Preparation may bump versions/timestamps and generate random label seeds.
  // Preserve source metadata; use the same stable defaults as JSON scene export.
  const sourceById = new Map(sourceElements.map(el => [el.id, el]));
  const exportedIds = new Set(scoped.map(el => el.id));
  const stable = scoped.map(el => {
    const source = sourceById.get(el.id);
    const timestamp = Date.parse(source?.updatedAt ?? source?.createdAt ?? '');
    return withDeterministicSeeds({
      ...el,
      frameId: el.frameId && !exportedIds.has(el.frameId) ? null : el.frameId,
      seed: source?.seed,
      versionNonce: source?.versionNonce,
      version: source?.version ?? 1,
      updated: typeof source?.updated === 'number' ? source.updated : Number.isNaN(timestamp) ? 1 : timestamp
    });
  });
  return mod.serializeAsJSON(stable, appState, files, 'local');
}

// Excalidraw's SVG exporter cuts the arrow/line stroke behind a label with a
// mask hole exactly the label's size, so a dashed or solid line runs right up
// to the letters. The editor's canvas renderer clears the label box grown by
// BOUND_TEXT_PADDING on every side (renderElement.ts, generateElementCanvas);
// give the SVG hole the same margin so exports look like the editor.
export const ARROW_LABEL_GAP = 5; // = BOUND_TEXT_PADDING in @excalidraw/common

export function padArrowLabelMasks(svg: Element, elements: Record<string, any>[]): void {
  const labelled = new Set(
    elements
      .filter(el => (el.type === 'arrow' || el.type === 'line') &&
        el.boundElements?.some((b: any) => b?.type === 'text'))
      .map(el => `mask-${el.id}`)
  );
  if (labelled.size === 0) return;
  for (const mask of Array.from(svg.getElementsByTagName('mask'))) {
    if (!labelled.has(mask.getAttribute('id') ?? '')) continue;
    for (const rect of Array.from(mask.getElementsByTagName('rect'))) {
      if (rect.getAttribute('fill') !== '#000') continue;
      for (const [pos, size] of [['x', 'width'], ['y', 'height']] as const) {
        const start = Number(rect.getAttribute(pos));
        const length = Number(rect.getAttribute(size));
        if (!Number.isFinite(start) || !Number.isFinite(length)) continue;
        rect.setAttribute(pos, String(start - ARROW_LABEL_GAP));
        rect.setAttribute(size, String(length + 2 * ARROW_LABEL_GAP));
      }
    }
  }
}

export async function renderSvgWithExcalidraw(
  preparedElements: Record<string, any>[],
  files: Record<string, any>,
  options: ExcalidrawSvgOptions
): Promise<string> {
  const mod = await loadExcalidrawNode();
  const win = getDomWindow();

  const svg = await mod.exportToSvg({
    elements: preparedElements,
    appState: {
      exportBackground: options.background,
      viewBackgroundColor: options.viewBackgroundColor,
      exportWithDarkMode: options.dark,
      exportScale: 1,
      exportEmbedScene: false,
      // Same frame rendering as the live tab
      frameRendering: { enabled: true, name: true, outline: true, clip: true }
    },
    files,
    exportPadding: options.padding,
    exportingFrame: options.exportingFrame ?? null,
    skipInliningFonts: true,
    renderEmbeddables: false
  });

  padArrowLabelMasks(svg, preparedElements);

  // Excalidraw sets an explicit xmlns attribute; jsdom's serializer also emits
  // the namespace declaration, producing a duplicate attribute that XML
  // parsers reject. Browsers dedupe it, so drop the explicit one here.
  svg.removeAttribute('xmlns');
  return new win.XMLSerializer().serializeToString(svg);
}
