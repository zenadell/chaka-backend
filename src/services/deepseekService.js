const OpenAI = require('openai');

const DEEPSEEK_MODEL_MAP = {
  'deepseek-chat':     { modelId: 'deepseek-chat',     temperature: 0.5, maxTokens: 8192 },
  'deepseek-reasoner': { modelId: 'deepseek-reasoner', temperature: 0.2, maxTokens: 16384 },
};

const DEFAULT_DEEPSEEK_MODEL = 'deepseek-chat';

/**
 * Convert Gemini-format contents array → OpenAI messages array.
 * Gemini: { role: 'user'|'model', parts: [{ text }] }
 * OpenAI: { role: 'user'|'assistant'|'system', content: string }
 */
function convertContents(contents) {
  const messages = [];

  for (const msg of contents) {
    if (msg.role === 'system') {
      const text = msg.parts?.map(p => p.text || '').join('') || msg.content || '';
      if (text) messages.push({ role: 'system', content: text });
      continue;
    }

    const role = msg.role === 'model' ? 'assistant' : 'user';
    const text = (msg.parts || []).map(p => p.text || '').join('');

    if (!text) continue;

    // Merge consecutive same-role messages
    const last = messages[messages.length - 1];
    if (last && last.role === role) {
      last.content += '\n' + text;
    } else {
      messages.push({ role, content: text });
    }
  }

  return messages;
}

/**
 * Stream a DeepSeek chat response.
 * Returns { stream } where stream yields objects with a .text() method —
 * identical interface to Gemini's streamGeminiChat so chatController needs minimal changes.
 */
async function streamDeepSeekChat(apiKey, payload, requestedModel) {
  const client = new OpenAI({
    baseURL: 'https://api.deepseek.com',
    apiKey,
  });

  const entry = DEEPSEEK_MODEL_MAP[requestedModel] || DEEPSEEK_MODEL_MAP[DEFAULT_DEEPSEEK_MODEL];
  console.log(`[streamDeepSeekChat] using model=${entry.modelId}`);

  const messages = convertContents(payload.contents || []);

  if (!messages.length) {
    throw new Error('No messages to send to DeepSeek');
  }

  const stream = await client.chat.completions.create({
    model: entry.modelId,
    messages,
    temperature: entry.temperature,
    max_tokens: entry.maxTokens,
    stream: true,
  });

  return {
    stream: (async function* () {
      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) {
          yield { text: () => delta };
        }
      }
    })()
  };
}

module.exports = { streamDeepSeekChat, DEEPSEEK_MODEL_MAP, DEFAULT_DEEPSEEK_MODEL };
