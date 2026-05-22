const Anthropic = require('@anthropic-ai/sdk');

// Claude model map — mirrors the structure in geminiService.js
const CLAUDE_MODEL_MAP = {
  'claude-opus-4-7':   { modelId: 'claude-opus-4-7',   maxTokens: 16000, temperature: 0.7 },
  'claude-sonnet-4-6': { modelId: 'claude-sonnet-4-6', maxTokens: 16000, temperature: 0.7 },
  'claude-haiku-4-5':  { modelId: 'claude-haiku-4-5-20251001', maxTokens: 8192, temperature: 0.7 },
};

const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-6';

/**
 * Convert Gemini-format contents array → Claude messages array.
 * Gemini: { role: 'user'|'model', parts: [{ text }|{ inlineData }] }
 * Claude: { role: 'user'|'assistant', content: string | content_block[] }
 */
function convertContents(contents) {
  const system = [];
  const messages = [];

  for (const msg of contents) {
    // Extract system instructions embedded as first user turn (common pattern)
    if (msg.role === 'system') {
      const text = msg.parts?.map(p => p.text || '').join('') || msg.content || '';
      if (text) system.push(text);
      continue;
    }

    const role = msg.role === 'model' ? 'assistant' : 'user';
    const parts = msg.parts || [];

    const contentBlocks = [];

    for (const part of parts) {
      if (part.text) {
        contentBlocks.push({ type: 'text', text: part.text });
      } else if (part.inlineData) {
        // Image data — Claude supports base64 images
        contentBlocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: part.inlineData.mimeType || 'image/jpeg',
            data: part.inlineData.data,
          }
        });
      }
    }

    if (contentBlocks.length === 0) continue;

    // Merge consecutive same-role messages (Claude requires alternating roles)
    const last = messages[messages.length - 1];
    if (last && last.role === role) {
      if (typeof last.content === 'string') {
        last.content = [{ type: 'text', text: last.content }, ...contentBlocks];
      } else {
        last.content.push(...contentBlocks);
      }
    } else {
      messages.push({
        role,
        content: contentBlocks.length === 1 && contentBlocks[0].type === 'text'
          ? contentBlocks[0].text
          : contentBlocks
      });
    }
  }

  return { system: system.join('\n'), messages };
}

/**
 * Stream a Claude chat response.
 * Returns { stream } where stream yields objects with a .text() method —
 * identical interface to Gemini's streamGeminiChat so chatController needs no changes.
 */
async function streamClaudeChat(apiKey, payload, requestedModel) {
  const client = new Anthropic({ apiKey });

  const entry = CLAUDE_MODEL_MAP[requestedModel] || CLAUDE_MODEL_MAP[DEFAULT_CLAUDE_MODEL];
  console.log(`[streamClaudeChat] using model=${entry.modelId}`);

  const { system, messages } = convertContents(payload.contents || []);

  // Ensure messages array is not empty and starts with user
  if (!messages.length) {
    throw new Error('No messages to send to Claude');
  }

  const params = {
    model: entry.modelId,
    max_tokens: entry.maxTokens,
    temperature: entry.temperature,
    messages,
  };

  if (system) params.system = system;

  const stream = await client.messages.stream(params);

  // Return same { stream } shape as Gemini — each item has .text()
  return {
    stream: (async function* () {
      for await (const event of stream) {
        if (
          event.type === 'content_block_delta' &&
          event.delta?.type === 'text_delta'
        ) {
          const t = event.delta.text;
          yield { text: () => t };
        }
      }
    })()
  };
}

/**
 * Check if Claude is available (key present and non-empty).
 */
function isClaudeAvailable() {
  const key = process.env.ANTHROPIC_API_KEY;
  return !!(key && key.trim().length > 0 && key.trim() !== 'your-key-here');
}

module.exports = { streamClaudeChat, isClaudeAvailable, CLAUDE_MODEL_MAP, DEFAULT_CLAUDE_MODEL };
