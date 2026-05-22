'use strict';

/**
 * humanize.js — Action humanization helpers (Phase 5.5)
 *
 * Adds organic randomness to agent actions so behavior analysis systems
 * (Instagram, LinkedIn, Cloudflare, Akamai) don't flag the session as a bot.
 *
 *   • Random delay between actions (read, click, type)
 *   • Mouse movement jitter
 *   • Reading-time pauses on text-heavy pages
 */

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Random delay for a given action type (ms) */
function humanDelay(actionType = 'default') {
  switch (actionType) {
    case 'read':       return rand(800, 2200);   // user reads a heading / scans
    case 'click':      return rand(180, 520);    // user hovers → clicks
    case 'type-char':  return rand(45, 140);     // per keystroke
    case 'submit':     return rand(400, 900);    // hesitation before submitting
    case 'navigate':   return rand(300, 700);    // page-to-page mental shift
    case 'scroll':     return rand(120, 380);
    default:           return rand(200, 600);
  }
}

/**
 * Add 3-7px noise to a click coordinate so the click doesn't land
 * pixel-perfect on the element center every time.
 */
function jitterCoord(x, y) {
  return {
    x: x + rand(-6, 6),
    y: y + rand(-5, 5),
  };
}

/**
 * Type a string with random per-keystroke delays.
 * Returns the total delay (ms) so the caller can also use it as a timing hint.
 *
 * @param {import('playwright').Page} page
 * @param {string} selector
 * @param {string} text
 */
async function humanType(page, selector, text) {
  await page.click(selector);
  let total = 0;
  for (const ch of text) {
    const d = humanDelay('type-char');
    total += d;
    await page.keyboard.type(ch, { delay: d });
  }
  return total;
}

/**
 * Sleep for a humanized duration before next action.
 */
function sleep(actionType) {
  return new Promise(r => setTimeout(r, humanDelay(actionType)));
}

module.exports = { humanDelay, jitterCoord, humanType, sleep, rand };
