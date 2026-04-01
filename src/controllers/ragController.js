// src/controllers/ragController.js
const { GoogleGenerativeAI } = require("@google/generative-ai");
const apiKeyManager = require('../utils/apiKeyManager');

// We use the same model family, but specifically the embedding model
const EMBEDDING_MODEL = "text-embedding-004";

/**
 * Helper to get a Google AI Client using the current active key
 */
function getGenAIClient() {
    const keyInfo = apiKeyManager.getCurrentKey();
    if (!keyInfo) throw new Error("No API keys available");
    return new GoogleGenerativeAI(keyInfo.key);
}

exports.embedText = async (req, res) => {
    try {
        const { text } = req.body;
        if (!text) {
            return res.status(400).json({ error: "No text provided" });
        }

        const genAI = getGenAIClient();
        const model = genAI.getGenerativeModel({ model: EMBEDDING_MODEL });

        // Generate embedding on the server (FAST)
        const result = await model.embedContent(text);
        const embedding = result.embedding.values;

        // Send the vector back to the client (or store it in Firestore later)
        res.json({ embedding });

    } catch (error) {
        console.error("Embedding Error:", error);
        apiKeyManager.reportFailure(apiKeyManager.getCurrentKey()?.id);
        res.status(500).json({ error: "Failed to generate embedding" });
    }
};

// In a real production app, you might parse PDFs here using 'pdf-parse' 
// rather than sending raw text from the client. 
// For now, we will keep it simple and let the client parse text, 
// but offload the HEAVY math to the server.