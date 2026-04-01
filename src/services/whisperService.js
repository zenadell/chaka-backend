const OpenAI = require('openai');
const fs = require('fs');

async function transcribeAudio(filePath, apiKey) {
    const openai = new OpenAI({ apiKey: apiKey });

    try {
        const translation = await openai.audio.transcriptions.create({
            file: fs.createReadStream(filePath),
            model: "whisper-1",
            response_format: "text", // Just give us the raw text
        });

        return translation;
    } catch (error) {
        console.error("Whisper Error:", error);
        throw new Error("Failed to transcribe audio.");
    }
}

module.exports = { transcribeAudio };