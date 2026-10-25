import { test, expect } from '@playwright/test';

// frontend/src/handmath-symbols.css adds HandMath Symbols as an Excalifont
// face for the maths symbols Excalifont lacks.
const LABEL = 'x² ≤ 4, ∇p → Δ ✓';

test('Excalifont labels draw maths symbols from HandMath Symbols', async ({ page, request }) => {
  const seeded = await request.post('/api/elements/sync', {
    data: {
      elements: [{
        id: 'hand-label', type: 'text', x: 100, y: 100, width: 400, height: 50,
        text: LABEL, originalText: LABEL, fontSize: 40, fontFamily: 5, strokeColor: '#1e1e1e',
      }],
    },
  });
  expect(seeded.ok()).toBeTruthy();
  await page.goto('/');
  await expect(page.locator('.excalidraw')).toBeVisible();

  const widths = await page.evaluate(async label => {
    await document.fonts.load('40px Excalifont', label);
    const context = document.createElement('canvas').getContext('2d');
    // At 1000 px one pixel is one font unit; at small sizes Chrome rounds
    // advances to whole pixels.
    context.font = '1000px Excalifont, Xiaolai, sans-serif';
    const faces = [...document.fonts].filter(face => face.family.replace(/"/g, '') === 'Excalifont');
    return {
      leq: context.measureText('≤').width,
      delta: context.measureText('Δ').width,
      handFaceLoaded: faces.some(face => face.unicodeRange.includes('2264') && face.status === 'loaded'),
    };
  }, LABEL);
  expect(widths.handFaceLoaded).toBe(true);
  // HandMath Symbols' advances, in units per 1000 em; the machine's own
  // fonts give other widths (DejaVu Sans: ≤ 838, Δ 684).
  expect(widths.leq).toBe(601);
  expect(widths.delta).toBe(582);

  if (process.env.HAND_SYMBOLS_SHOT) {
    await page.waitForTimeout(500);
    await page.screenshot({ path: process.env.HAND_SYMBOLS_SHOT, clip: { x: 0, y: 0, width: 900, height: 400 } });
  }
});
