'use strict';

/**
 * visualPuzzleSolver.js — Phase 5.6
 *
 * Vision-based puzzle/CAPTCHA solver. The main agent (gpt-oss / Llama 3.3)
 * stays text-only and fast. When it gets blocked by a visual challenge it
 * cannot reason about (slider captcha, "click the X", press-and-hold,
 * popup overlay, image grid), it calls this tool. We:
 *
 *   1. Screenshot the current page
 *   2. Send to Gemini 2.5 Flash Vision with a strict tagged-output prompt
 *   3. Parse the proposed action (click coords / drag path / hold time)
 *   4. Execute via Playwright mouse on the live page
 *   5. Return success + next-step guidance to the agent
 *
 * Why this is the right protocol:
 *   • Main loop runs on a text LLM (fast, cheap, deterministic tool calling)
 *   • Vision is invoked SURGICALLY only when needed (saves Gemini quota)
 *   • Gemini Vision is genuinely good at locating UI elements + reading puzzles
 *   • Mirrors the pattern Anthropic Computer Use + OpenAI Operator use
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');
const apiKeyManager = require('../utils/apiKeyManager');

// Round-robin Gemini key picker — same pool as the rest of the app
function pickGeminiKey() {
  const keys = apiKeyManager.keys?.filter(k => k.type === 'text' && k.key)?.map(k => k.key) || [];
  if (!keys.length) {
    const fb = apiKeyManager.getCurrentKey()?.key;
    if (fb) return fb;
    return null;
  }
  return keys[Math.floor(Math.random() * keys.length)];
}

// ── Strict tagged-output prompt ──────────────────────────────────────────────
function buildPrompt(viewportW, viewportH, context) {
  const ctxLine = context ? `\nContext from agent: "${context.slice(0, 400)}"\n` : '';
  return `You are a visual CAPTCHA / puzzle / UI-blocker solver. You see a screenshot of a webpage where an automated agent got stuck. Your job: identify the visual challenge and tell the agent EXACTLY where to click / drag / press.
${ctxLine}
PUZZLE TYPES YOU'LL SEE:
- checkbox       — simple "I'm not a robot" tick box. Output the checkbox center coords.
- click_target   — "click the X" / "click the close button" / dismiss popup. Output target coords.
- popup          — modal/banner blocking the page. Output the X / Close button coords.
- slider         — drag a slider piece left→right to match. Output drag_from + drag_to.
- image_select   — grid of images, "select all squares with [thing]". Output the pixel coords of EACH matching tile center as a separate [CLICK] line. Then if a Submit/Verify button is visible, add [SUBMIT_COORDS]: x,y.
- press_hold     — press and hold a button for N seconds. Output coords + hold_ms.
- rotation       — rotate an image to be upright. Output rotate_deg (clockwise).
- try_again      — a "try again" button after a failed attempt. Output that button's coords.
- none           — no visual puzzle visible. The page is fine, the agent should just continue.

COORDINATES: pixels from the top-left of the screenshot. The viewport is ${viewportW}x${viewportH}.

OUTPUT FORMAT (strict — one line per field, NO other text, NO markdown, NO commentary):
[TYPE]: <one of the puzzle types above>
[ACTION]: <one-sentence plain description of what you want done>
[COORDS]: x, y                 (for checkbox / click_target / popup / press_hold / try_again)
[DRAG_FROM]: x, y              (for slider only)
[DRAG_TO]: x, y                (for slider only)
[CLICK]: x, y                  (for image_select — one [CLICK] line per matching tile, repeat as needed)
[SUBMIT_COORDS]: x, y          (for image_select — submit/verify button if visible)
[ROTATE_DEG]: 90               (for rotation only — clockwise degrees)
[HOLD_MS]: 2000                (for press_hold only — duration)
[CONFIDENCE]: high|medium|low

EXAMPLE — for a "select all squares with ducks" 3x3 grid where tiles at positions 2, 4, 7 contain ducks:
[TYPE]: image_select
[ACTION]: Click the 3 squares containing ducks then submit
[CLICK]: 480, 340
[CLICK]: 320, 480
[CLICK]: 320, 620
[SUBMIT_COORDS]: 555, 740
[CONFIDENCE]: high

If you see NO visual challenge, just output:
[TYPE]: none
[CONFIDENCE]: high`;
}

// ── Compress + reduce screenshot size before sending to Gemini ──────────────
async function compressScreenshot(base64) {
  try {
    const sharp = require('sharp');
    const buf = Buffer.from(base64, 'base64');
    const out = await sharp(buf)
      .resize({ width: 1366, withoutEnlargement: true })
      .jpeg({ quality: 78 })
      .toBuffer();
    return out.toString('base64');
  } catch {
    return base64; // sharp not available or failed — send original
  }
}

// ── Main API ────────────────────────────────────────────────────────────────

/**
 * Analyze a page screenshot and return what action to take to solve any puzzle.
 *
 * @param {string} screenshotBase64
 * @param {{ viewport_w?: number, viewport_h?: number, context?: string }} opts
 * @returns {Promise<{
 *   puzzle_type: string,
 *   action: string,
 *   coords?: [number, number],
 *   drag_from?: [number, number],
 *   drag_to?: [number, number],
 *   images_to_select?: number[],
 *   rotate_deg?: number,
 *   hold_ms?: number,
 *   confidence: 'high'|'medium'|'low',
 *   raw_response: string,
 * }>}
 */
async function analyzePuzzle(screenshotBase64, opts = {}) {
  const apiKey = pickGeminiKey();
  if (!apiKey) throw new Error('No Gemini key available for vision');

  const { viewport_w = 1366, viewport_h = 800, context = '' } = opts;
  const compressed = await compressScreenshot(screenshotBase64);

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    generationConfig: { temperature: 0.1, maxOutputTokens: 512 },
  });

  const result = await model.generateContent({
    contents: [{
      role: 'user',
      parts: [
        { inlineData: { mimeType: 'image/jpeg', data: compressed } },
        { text: buildPrompt(viewport_w, viewport_h, context) },
      ],
    }],
  });

  const text = result.response?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  return parseResponse(text);
}

function parseResponse(text) {
  const get = (re) => re.exec(text);
  const getCoords = (label) => {
    const m = new RegExp(`\\[${label}\\]:\\s*(\\d+)\\s*,\\s*(\\d+)`, 'i').exec(text);
    return m ? [parseInt(m[1], 10), parseInt(m[2], 10)] : undefined;
  };

  const parsed = {
    puzzle_type: (get(/\[TYPE\]:\s*([a-z_]+)/i)?.[1] || 'unknown').toLowerCase(),
    action: get(/\[ACTION\]:\s*(.+)/i)?.[1]?.trim() || '',
    confidence: (get(/\[CONFIDENCE\]:\s*(\w+)/i)?.[1] || 'low').toLowerCase(),
    raw_response: text,
  };

  const coords = getCoords('COORDS');           if (coords) parsed.coords = coords;
  const dragFrom = getCoords('DRAG_FROM');      if (dragFrom) parsed.drag_from = dragFrom;
  const dragTo = getCoords('DRAG_TO');          if (dragTo) parsed.drag_to = dragTo;

  // Phase 5.6.1: image_select returns multiple [CLICK]: x,y lines
  const clickMatches = [...text.matchAll(/\[CLICK\]:\s*(\d+)\s*,\s*(\d+)/gi)];
  if (clickMatches.length) {
    parsed.clicks = clickMatches.map(m => [parseInt(m[1], 10), parseInt(m[2], 10)]);
  }
  const submitCoords = getCoords('SUBMIT_COORDS');
  if (submitCoords) parsed.submit_coords = submitCoords;

  // Legacy [IMAGES]: 1,3,5 grid positions (kept for back-compat)
  const imagesM = get(/\[IMAGES\]:\s*([\d,\s]+)/i);
  if (imagesM) parsed.images_to_select = imagesM[1].split(',').map(s => parseInt(s.trim(), 10)).filter(Boolean);

  const rotateM = get(/\[ROTATE_DEG\]:\s*(\d+)/i);
  if (rotateM) parsed.rotate_deg = parseInt(rotateM[1], 10);

  const holdM = get(/\[HOLD_MS\]:\s*(\d+)/i);
  if (holdM) parsed.hold_ms = parseInt(holdM[1], 10);

  return parsed;
}

/**
 * Execute the proposed solution on the live Playwright page.
 * Returns a summary of what was done so the agent can decide next.
 *
 * @param {import('playwright').Page} page
 * @param {Awaited<ReturnType<typeof analyzePuzzle>>} solution
 */
async function executeSolution(page, solution) {
  switch (solution.puzzle_type) {
    case 'checkbox':
    case 'click_target':
    case 'popup':
    case 'try_again': {
      if (!solution.coords) throw new Error(`No coords provided for ${solution.puzzle_type}`);
      // Human-like jitter: small noise on the click point
      const [x, y] = solution.coords;
      const jx = x + (Math.floor(Math.random() * 6) - 3);
      const jy = y + (Math.floor(Math.random() * 6) - 3);
      await page.mouse.move(jx, jy, { steps: 8 });
      await page.waitForTimeout(120 + Math.floor(Math.random() * 180));
      await page.mouse.click(jx, jy);
      await page.waitForTimeout(1500);
      return { executed: 'click', kind: solution.puzzle_type, coords: [jx, jy] };
    }

    case 'slider': {
      if (!solution.drag_from || !solution.drag_to) throw new Error('No drag path provided');
      const [fx, fy] = solution.drag_from;
      const [tx, ty] = solution.drag_to;
      await page.mouse.move(fx, fy, { steps: 6 });
      await page.waitForTimeout(150);
      await page.mouse.down();
      // Move in 24 small steps with light easing for natural feel
      const steps = 24;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        // Ease-out-cubic: starts fast, ends slow
        const e = 1 - Math.pow(1 - t, 3);
        await page.mouse.move(fx + (tx - fx) * e, fy + (ty - fy) * e);
        await page.waitForTimeout(15 + Math.floor(Math.random() * 12));
      }
      await page.waitForTimeout(80);
      await page.mouse.up();
      await page.waitForTimeout(1500);
      return { executed: 'drag', from: [fx, fy], to: [tx, ty] };
    }

    case 'press_hold': {
      if (!solution.coords || !solution.hold_ms) throw new Error('Press-hold needs coords + hold_ms');
      const [x, y] = solution.coords;
      await page.mouse.move(x, y, { steps: 8 });
      await page.waitForTimeout(150);
      await page.mouse.down();
      await page.waitForTimeout(Math.min(solution.hold_ms, 8000)); // cap at 8s for safety
      await page.mouse.up();
      await page.waitForTimeout(1500);
      return { executed: 'press_hold', coords: [x, y], duration_ms: solution.hold_ms };
    }

    case 'image_select': {
      // Phase 5.6.1: vision model now returns pixel coords for each tile +
      // optional submit button. Click each tile with human-like jitter,
      // then click submit if provided.
      const clicks = solution.clicks || [];
      if (!clicks.length) {
        return {
          executed: 'partial',
          kind: 'image_select',
          note: 'Vision model did not return pixel coords for tiles. Retry with more specific context.',
        };
      }
      const clicked = [];
      for (const [x, y] of clicks) {
        const jx = x + (Math.floor(Math.random() * 6) - 3);
        const jy = y + (Math.floor(Math.random() * 6) - 3);
        await page.mouse.move(jx, jy, { steps: 8 });
        await page.waitForTimeout(180 + Math.floor(Math.random() * 260));
        await page.mouse.click(jx, jy);
        clicked.push([jx, jy]);
        // Brief pause so the page can register the selection before next click
        await page.waitForTimeout(380 + Math.floor(Math.random() * 240));
      }
      // Click submit if provided
      let submitted = false;
      if (solution.submit_coords) {
        const [sx, sy] = solution.submit_coords;
        await page.waitForTimeout(500);
        await page.mouse.move(sx, sy, { steps: 8 });
        await page.waitForTimeout(220);
        await page.mouse.click(sx, sy);
        submitted = true;
        await page.waitForTimeout(1500);
      } else {
        await page.waitForTimeout(1000);
      }
      return {
        executed: 'image_select',
        clicks_made: clicked.length,
        submitted,
        coords: clicked,
        submit_coords: solution.submit_coords || null,
      };
    }

    case 'rotation': {
      return {
        executed: 'partial',
        kind: 'rotation',
        rotate_deg: solution.rotate_deg,
        note: 'Rotation puzzles typically need a custom drag-arc on a slider. Tell the agent to look for the rotation handle and call this tool again with context describing it.',
      };
    }

    case 'none':
      return { executed: 'none', note: 'Vision model saw no puzzle on the page. The agent should continue with normal actions.' };

    default:
      throw new Error(`Unknown / unsupported puzzle type: ${solution.puzzle_type}`);
  }
}

module.exports = { analyzePuzzle, executeSolution, parseResponse };
