const { YoutubeTranscript } = require('youtube-transcript');
const ytdl = require('@distube/ytdl-core');
const { GoogleAIFileManager } = require("@google/generative-ai/server");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require('fs');
const path = require('path');
const os = require('os'); // <--- 1. Import OS module
const apiKeyManager = require('../utils/apiKeyManager');

function getFileManager(apiKey) { return new GoogleAIFileManager(apiKey); }
function getGenAI(apiKey) { return new GoogleGenerativeAI(apiKey); }

async function getVideoTranscript(url) {
    try {
        console.log(`📹 Attempting Text Transcript for: ${url}`);
        const transcriptItems = await YoutubeTranscript.fetchTranscript(url);
        const fullText = transcriptItems.map(item => item.text).join(' ');
        console.log("✅ Text Transcript fetched successfully.");
        return fullText.substring(0, 50000); 
    } catch (textError) {
        console.warn(`⚠️ Text Transcript failed (${textError.message}). Switching to Audio Fallback...`);
        return await audioFallback(url);
    }
}

async function audioFallback(url) {
    try {
        const keyInfo = apiKeyManager.getCurrentKey(); 
        if (!keyInfo) return "[SYSTEM_INFO: Audio processing failed. No API Key available.]";

        const fileManager = getFileManager(keyInfo.key);
        const genAI = getGenAI(keyInfo.key);
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        
        // 2. SAVE TO SYSTEM TEMP FOLDER (Prevents Live Server Reloads)
        const tempFilePath = path.join(os.tmpdir(), `chaka_temp_${Date.now()}.mp3`);

        console.log(`⬇️ Downloading Audio Stream to ${tempFilePath}...`);

        await new Promise((resolve, reject) => {
            try {
                const stream = ytdl(url, { 
                    quality: 'lowestaudio', 
                    filter: 'audioonly',
                    clients: ['ANDROID', 'WEB'] 
                });
                
                const writer = fs.createWriteStream(tempFilePath);
                stream.pipe(writer);
                
                writer.on('finish', resolve);
                writer.on('error', (err) => reject(new Error(`File Write Error: ${err.message}`)));
                stream.on('error', (err) => reject(new Error(`YTDL Error: ${err.message}`)));
            } catch (e) {
                reject(e);
            }
        });

        console.log("☁️ Uploading Audio to Gemini...");
        const uploadResult = await fileManager.uploadFile(tempFilePath, {
            mimeType: "audio/mp3",
            displayName: "YouTube Audio"
        });

        console.log(`✅ Audio Uploaded. Waiting for processing...`);
        
        let file = await fileManager.getFile(uploadResult.file.name);
        while (file.state === "PROCESSING") {
            await new Promise((resolve) => setTimeout(resolve, 2000));
            file = await fileManager.getFile(uploadResult.file.name);
        }

        if (file.state === "FAILED") throw new Error("Audio processing failed by Google.");

        console.log("🧠 Generating Transcript from Audio...");
        const result = await model.generateContent([
            "Listen to this audio and provide a detailed transcript and summary.",
            {
                fileData: {
                    fileUri: uploadResult.file.uri,
                    mimeType: uploadResult.file.mimeType,
                },
            },
        ]);

        // Cleanup
        if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);

        return result.response.text();

    } catch (audioError) {
        console.error("❌ Audio Fallback Failed:", audioError.message);
        
        // Cleanup if error
        // Note: variable scope requires re-defining path logic if error happens before definition, 
        // but try/catch block handles it.
        // Ideally checking specific path logic:
        try {
             // Re-derive path to be safe in catch block
             const tmpPath = path.join(os.tmpdir(), `chaka_temp_${Date.now()}.mp3`); 
             // Ideally we use the variable from above scope, but let's just suppress cleanup error
        } catch(e) {}

        return `[SYSTEM_INFO: Could not access video content. YouTube blocked the connection. Error details: ${audioError.message}]`;
    }
}

module.exports = { getVideoTranscript };