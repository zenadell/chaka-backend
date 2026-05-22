const { isClaudeAvailable } = require('./claudeService');

/**
 * Task types and which brain handles them best.
 *
 * CLAUDE  → deep reasoning, code, documents, math, long analysis, writing
 * GEMINI  → voice, images/video, realtime, quick chat, multimodal
 */

const CLAUDE_KEYWORDS = [
  // Code
  'write code', 'debug', 'fix this code', 'refactor', 'function', 'algorithm',
  'implement', 'script', 'programming', 'syntax error', 'compile', 'deploy',
  'class ', 'async ', 'await ', 'typescript', 'javascript', 'python', 'rust',
  // Reasoning & Analysis
  'analyze', 'explain in detail', 'compare', 'evaluate', 'critique', 'review',
  'pros and cons', 'trade-off', 'reasoning', 'logic', 'argument', 'hypothesis',
  'research', 'summarize this', 'what does this mean', 'break down',
  // Documents & Writing
  'write a report', 'write an essay', 'draft', 'contract', 'proposal', 'document',
  'legal', 'clause', 'policy', 'terms', 'email', 'letter', 'cover letter',
  // Math
  'calculate', 'equation', 'formula', 'proof', 'math', 'algebra', 'calculus',
  'statistics', 'probability', 'derivative', 'integral',
  // Long context
  'read this', 'look at this', 'check this file', 'here is the code',
];

const GEMINI_SIGNALS = {
  hasImage: false,
  isVoice: false,
  isLive: false,
};

/**
 * Detect task type from the request and decide which model family to use.
 *
 * Returns:
 *   { brain: 'claude'|'gemini', reason: string, suggestedModel: string }
 */
function routeRequest({ model, contents = [], voiceInput = false, hasImage = false }) {
  // 1. Hard-override: voice or image always goes to Gemini (it has the Live API + Vertex)
  if (voiceInput) {
    return { brain: 'gemini', reason: 'voice input', suggestedModel: model || 'gemini-2.5-flash' };
  }

  if (hasImage) {
    return { brain: 'gemini', reason: 'image/vision input', suggestedModel: model || 'gemini-2.5-flash' };
  }

  // 2. If caller explicitly requested a Claude model, respect it
  if (model && model.startsWith('claude-')) {
    if (isClaudeAvailable()) {
      return { brain: 'claude', reason: 'explicit claude model requested', suggestedModel: model };
    }
    // Key not funded yet — fall through to Gemini
    console.warn('[modelRouter] Claude model requested but ANTHROPIC_API_KEY is not set. Falling back to Gemini.');
    return { brain: 'gemini', reason: 'claude requested but key unavailable', suggestedModel: 'gemini-2.5-flash' };
  }

  // 3. If caller explicitly requested a Gemini model, respect it
  if (model && model.startsWith('gemini-')) {
    return { brain: 'gemini', reason: 'explicit gemini model requested', suggestedModel: model };
  }

  // 4. Auto-route based on content analysis (only if Claude is funded)
  if (isClaudeAvailable()) {
    const lastUserText = extractLastUserText(contents).toLowerCase();
    const matchedKeyword = CLAUDE_KEYWORDS.find(kw => lastUserText.includes(kw));
    if (matchedKeyword) {
      return {
        brain: 'claude',
        reason: `matched keyword: "${matchedKeyword}"`,
        suggestedModel: 'claude-sonnet-4-6'
      };
    }

    // Long messages (> 1500 chars) → Claude handles long context better
    if (lastUserText.length > 1500) {
      return { brain: 'claude', reason: 'long message → better with Claude', suggestedModel: 'claude-sonnet-4-6' };
    }
  }

  // 5. Default → Gemini (always available)
  return { brain: 'gemini', reason: 'default', suggestedModel: model || 'gemini-2.5-flash' };
}

function extractLastUserText(contents) {
  for (let i = contents.length - 1; i >= 0; i--) {
    const msg = contents[i];
    if (msg.role === 'user') {
      return (msg.parts || []).map(p => p.text || '').join(' ');
    }
  }
  return '';
}

/**
 * Check if the contents include an image part.
 */
function detectImage(contents = []) {
  return contents.some(msg =>
    (msg.parts || []).some(p => p.inlineData)
  );
}

module.exports = { routeRequest, detectImage };
