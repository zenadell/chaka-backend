const { GoogleGenerativeAI } = require("@google/generative-ai");

// Map of allowed "request keys" -> actual model identifier + default generation settings
const MODEL_MAP = {
  "gemini-2.5-flash": {
    modelId: "gemini-2.5-flash",
    temperature: 0.5,
    maxOutputTokens: 65536
  },
  "gemini-2.5-pro": {
    modelId: "gemini-2.5-pro",
    temperature: 0.2,
    maxOutputTokens: 65536
  },
  "gemini-3.1-pro-preview": {
    modelId: "gemini-3-pro-preview",
    temperature: 0.6,
    maxOutputTokens: 65536
  },
  "gemini-3-pro-preview-code": {
    modelId: "gemini-3-pro-preview-code",
    temperature: 0.2,
    maxOutputTokens: 65536
  },
  "gemini-3-pro-code": {
    modelId: "gemini-3-pro-preview-code",
    temperature: 0.2,
    maxOutputTokens: 65536
  }
};

async function streamGeminiChat(apiKey, payload, requestedModel) {
  try {
    const genAI = new GoogleGenerativeAI(apiKey);

    // Normalize requestedModel to a known key (fallback to default if unknown)
    const normalizedKey = (requestedModel || "").trim();
    const entry = MODEL_MAP[normalizedKey];

    if (!entry) {
      console.warn(`[streamGeminiChat] unknown requestedModel "${requestedModel}", falling back to gemini-2.5-flash`);
    }

    // Use the mapped entry or fallback
    const { modelId, temperature = 0.7, maxOutputTokens = 2048 } = entry || MODEL_MAP["gemini-2.5-flash"];

    console.log(`[streamGeminiChat] using model=${modelId} temperature=${temperature} tokens=${maxOutputTokens}`);

    const model = genAI.getGenerativeModel({
      model: modelId,
      generationConfig: {
        maxOutputTokens,
        temperature,
        responseMimeType: "application/json"
      }
    });

    const result = await model.generateContentStream(payload);
    return result;
  } catch (error) {
    throw new Error(`Google SDK Error: ${error.message}`);
  }
}

module.exports = { streamGeminiChat };
