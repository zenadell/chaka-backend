const apiKeyManager = require('../utils/apiKeyManager');
const { searchWeb } = require('../services/searchService');
const { generateImage } = require('../services/imageService');
const { generateSpeech, generateSpeechRaw } = require('../services/ttsService');
const { getVideoTranscript } = require('../services/youtubeService');
const { transcribeAudio } = require('../services/whisperService');
const { sendEmail } = require('../services/emailService');
const { generateImageVertex, editImageVertex } = require('../services/vertexImageService');
const { generateReflection } = require('../services/reflectionService');
const admin = require('firebase-admin');
const { executeSql } = require('../services/tursoService');
const axios = require('axios'); // Needed for downloading the image buffer
const fs = require('fs');

// --- SEARCH ---
exports.handleSearch = async (req, res) => {
    const { query } = req.body;

    if (!query || query.trim() === '') {
        return res.status(400).json({ error: "Query cannot be empty." });
    }

    const apiKey = apiKeyManager.keys.find(k => k.type === 'search')?.key;
    if (!apiKey) {
        console.error('❌ No search API key configured');
        return res.status(503).json({ error: "Search service not configured. Please contact support." });
    }

    try {
        console.log(`🔍 Search request received for: "${query}"`);
        const result = await searchWeb(query, apiKey);
        console.log(`✅ Sending search results to client`);
        res.json({ result });
    } catch (error) {
        console.error('❌ Search handler error:', error.message);
        // Return a clear error message instead of generic message
        const statusCode = error.message.includes('timeout') ? 408 : 500;
        res.status(statusCode).json({ error: error.message });
    }
};

// --- IMAGE GENERATION (Now using Google Vertex exclusively) ---
exports.handleImageGen = async (req, res) => {
    const { prompt } = req.body;

    // Optional: You can keep the API key check if you want to gatekeep the feature, 
    // even though Vertex doesn't use the key directly.
    // const apiKeyPtr = apiKeyManager.getKey('image');
    // if (!apiKeyPtr) return res.status(503).json({ error: "No image generation service available." });

    try {
        console.log(`🎨 Calling Google Vertex AI for Image Gen: "${prompt}"`);
        // Call the Vertex function directly
        const imageUrl = await generateImageVertex(prompt);
        console.log(`✅ Image generation successful, returning URL: ${imageUrl}`);
        res.json({ imageUrl });
    } catch (error) {
        console.error("Vertex Gen Error:", error);
        // Provide a clear error message back to the frontend
        res.status(500).json({ error: `chaka Image Gen Failed: ${error.message}` });
    }
};

// --- IMAGE EDITING (With Retry) ---
exports.handleImageEdit = async (req, res) => {
    const { imageUrl, prompt } = req.body;

    if (!imageUrl) return res.status(400).json({ error: "No image URL provided." });

    try {
        console.log(`🎨 Downloading image for Google Vertex Edit...`);

        // 1. Download image (fail-fast: single attempt)
        let imageRes;
        try {
            imageRes = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 10000 });
        } catch (e) {
            const status = e.response?.status;
            if (status === 404) {
                return res.status(400).json({ error: "The original image has expired. Please upload it again." });
            }
            console.warn(`Image download failed (single attempt): ${e.message}`);
            throw new Error(`Could not download source image: ${e.message}`);
        }

        const imageBase64 = Buffer.from(imageRes.data).toString('base64');

        // 2. Call Vertex AI
        const newImageUrl = await editImageVertex(imageBase64, prompt);

        res.json({ imageUrl: newImageUrl });

    } catch (error) {
        console.error("Vertex Edit Failed:", error.message);

        // Give sharp/sanitizer time to fully release resources before next request
        await new Promise(r => setTimeout(r, 500));

        res.status(500).json({ error: error.message });
    }
};

// --- TTS ---
exports.handleTts = async (req, res) => {
    const { text } = req.body;
    const keyObj = apiKeyManager.keys.find(k => k.type === 'tts') || apiKeyManager.keys[0];
    if (!keyObj || !keyObj.key) return res.status(500).json({ error: "No TTS API key configured." });

    try {
        const audioBuffer = await generateSpeech(text, keyObj.key, keyObj.voiceId);
        res.set('Content-Type', 'audio/wav');
        res.send(audioBuffer);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

// --- TTS RAW (For streaming sentence queues) ---
exports.handleTtsRaw = async (req, res) => {
    const { text } = req.body;
    const keyObj = apiKeyManager.getTtsKey() || apiKeyManager.keys[0];
    if (!keyObj || !keyObj.key) return res.status(500).json({ error: "No API key configured." });

    try {
        const audioBase64 = await generateSpeechRaw(text, keyObj.key, keyObj.voiceId);
        res.json({ audio: audioBase64 });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

// --- YOUTUBE ---
exports.handleYoutube = async (req, res) => {
    const { url } = req.body;
    try {
        const transcript = await getVideoTranscript(url);
        res.json({ transcript });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

// --- MEMORY ---
exports.handleUpdateMemory = async (req, res) => {
    const userId = req.user ? req.user.uid : null;
    const { memoryText, topic, correctionId, emotionTag } = req.body;

    if (!userId) return res.status(401).json({ error: "Unauthorized User" });
    if (!memoryText) return res.status(400).json({ error: "Missing memoryText" });

    try {
        // A. SELF-CORRECTION / UPDATE LOOP LOGIC
        if (correctionId) {
            try {
                const oldMemResult = await executeSql('SELECT * FROM memories WHERE id = ? AND userId = ?', [correctionId, userId]);
                if (oldMemResult.rows.length > 0) {
                    await executeSql(
                        'UPDATE memories SET status = ?, archivedAt = CURRENT_TIMESTAMP, reason = ? WHERE id = ?',
                        ['ARCHIVED', 'Self-correction: replaced by new memory', correctionId]
                    );
                    console.log(`✅ Archived old memory: ${correctionId}`);
                }
            } catch (archiveError) {
                console.warn(`⚠️ Failed to archive memory ${correctionId}:`, archiveError.message);
            }
        }

        // B. EPISODIC / SEMANTIC STORAGE
        const memoryId = 'mem_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        const newTopic = topic || 'general';
        const newEmotion = emotionTag || null;

        await executeSql(
            `INSERT INTO memories (id, userId, text, topic, emotion, status, createdAt) VALUES (?, ?, ?, ?, ?, 'ACTIVE', CURRENT_TIMESTAMP)`,
            [memoryId, userId, memoryText, newTopic, newEmotion]
        );
        console.log(`✅ Created new memory with ID: ${memoryId}`);

        if (correctionId) {
            try {
                await executeSql('UPDATE memories SET replacedBy = ? WHERE id = ?', [memoryId, correctionId]);
            } catch (updateError) {
                console.warn(`⚠️ Failed to update replacedBy for ${correctionId}:`, updateError.message);
            }
        }

        // C. SYNCHRONIZE MEMORY TO USER PROFILE
        const userResult = await executeSql('SELECT memory, semanticMemory FROM users WHERE firebase_uid = ?', [userId]);
        const userData = userResult.rows[0] || {};

        let currentMemory = userData.memory || "";
        const newMemoryLine = `\n- [${new Date().toLocaleDateString()}] [Topic: ${newTopic}] [Emotion: ${newEmotion}] ${memoryText}`;
        const updatedMemory = currentMemory + newMemoryLine;
        const semanticMemory = userData.semanticMemory || "User is building a complex AI system.";

        await executeSql(
            'UPDATE users SET memory = ?, semanticMemory = ? WHERE firebase_uid = ?',
            [updatedMemory, semanticMemory, userId]
        );

        res.json({
            success: true,
            memoryId: memoryId,
            currentMemory: updatedMemory,
            structured: {
                id: memoryId,
                topic: newTopic,
                emotion: newEmotion,
                status: 'ACTIVE'
            }
        });
    } catch (error) {
        console.error('❌ Memory update error:', error);
        res.status(500).json({ error: error.message });
    }
};

// --- WHISPER ---
exports.handleWhisper = async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No audio file uploaded." });

    const apiKey = apiKeyManager.keys.find(k => k.type === 'whisper')?.key;
    if (!apiKey) {
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        return res.status(500).json({ error: "No OpenAI Whisper key configured." });
    }

    try {
        const text = await transcribeAudio(req.file.path, apiKey);
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.json({ text });
    } catch (error) {
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).json({ error: error.message });
    }
};

// --- EMAIL ---
exports.handleEmail = async (req, res) => {
    const { to, subject, body } = req.body;
    const emailKey = apiKeyManager.keys.find(k => k.type === 'email')?.key;
    if (!emailKey) return res.status(500).json({ error: "No Email credentials configured." });

    try {
        console.log(`📧 Sending email to ${to}...`);
        await sendEmail(to, subject, body, emailKey);
        res.json({ success: true, message: "Email sent." });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

// --- REFLECTION (Dreaming) ---
exports.handleReflection = async (req, res) => {
    const userId = req.user ? req.user.uid : null;
    if (!userId) return res.status(401).json({ error: "Unauthorized User" });

    try {
        const memoriesResult = await executeSql(
            "SELECT * FROM memories WHERE userId = ? AND status = 'ACTIVE' ORDER BY createdAt DESC LIMIT 50",
            [userId]
        );

        if (memoriesResult.rows.length === 0) {
            return res.json({ success: true, message: "No new memories to reflect upon." });
        }

        const activeMemories = memoriesResult.rows.map(row => {
            const created = new Date(row.createdAt + 'Z'); // Turso dates are UTC
            const dateStr = created.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            return `[${dateStr}] [Emotion: ${row.emotion || 'neutral'}] ${row.text}`;
        }).join('\n');

        console.log(`🧠 Starting Reflection Process for user ${userId}. Processing ${memoriesResult.rows.length} memories...`);

        const reflectionSummary = await generateReflection(activeMemories);

        await executeSql(
            'UPDATE users SET semanticMemory = ?, lastReflection = CURRENT_TIMESTAMP WHERE firebase_uid = ?',
            [reflectionSummary, userId]
        );

        console.log(`✅ Reflection complete. Semantic Memory updated.`);
        res.json({ success: true, summary: reflectionSummary });

    } catch (error) {
        console.error('❌ Reflection handler error:', error);
        res.status(500).json({ error: error.message });
    }
};

// --- DATABASE QUERY TOOL ---
exports.handleDatabaseQuery = async (req, res) => {
    const { collection: colName, field, value } = req.body;

    const ALLOWED_COLLECTIONS = ['users', 'subscriptions', 'orders', 'sessions', 'chats'];
    if (!ALLOWED_COLLECTIONS.includes(colName)) {
        return res.status(403).json({ error: `Access denied to table: ${colName}` });
    }

    try {
        let queryStr = `SELECT * FROM ${colName}`;
        const params = [];

        if (field && value) {
            // Very simple sanitization - field must be alphanumeric
            if (!/^[a-zA-Z0-9_]+$/.test(field)) {
                return res.status(400).json({ error: "Invalid field name" });
            }
            queryStr += ` WHERE ${field} = ?`;
            params.push(value);
        }

        queryStr += ` LIMIT 5`;

        const snapshot = await executeSql(queryStr, params);

        if (snapshot.rows.length === 0) {
            return res.json({ result: "No matching records found." });
        }

        res.json({ result: JSON.stringify(snapshot.rows, null, 2) });

    } catch (error) {
        console.error("Database Query Error:", error);
        res.status(500).json({ error: error.message });
    }
};

// --- LIVE STREAM CONFIG ---
exports.handleLiveConfig = async (req, res) => {
    try {
        // Prioritize specialized Multimodal Live key, fall back to general Gemini key
        let keyInfo = apiKeyManager.getMultimodalKey() || apiKeyManager.getCurrentKey();

        if (!keyInfo) {
            return res.status(503).json({ error: "No API key available for Live Mode." });
        }

        const voiceId = req.query.voiceId || keyInfo.voiceId || "Puck";
        const personaId = req.query.persona || "";
        const userId = req.query.userId || "";
        const sessionId = req.query.sessionId || "";
        
        let personaContext = "";
        let personaName = "CHAKA";
        let userMemoryText = "";
        let userContextText = "";

        console.log(`📡 Live Mode Config Request: personaId="${personaId}", userId="${userId}", voiceId="${voiceId}"`);

        // 1. Fetch Personality Context
        if (personaId && personaId !== "null" && personaId !== "undefined") {
            try {
                const personaRes = await executeSql('SELECT * FROM personalities WHERE id = ?', [personaId]);
                if (personaRes.rows.length > 0) {
                    const data = personaRes.rows[0];
                    personaContext = data.systemPrompt || data.description || "";
                    personaName = data.name || "CHAKA";
                    console.log(`🎭 Live Mode: Loaded persona "${personaName}"`);
                }
            } catch (err) {
                console.error(`❌ Persona fetch failed:`, err.message);
            }
        }

        // 2. Fetch User Context (Memory, Location, etc.)
        if (userId) {
            try {
                const userRes = await executeSql('SELECT * FROM users WHERE firebase_uid = ?', [userId]);
                if (userRes.rows.length > 0) {
                    const userData = userRes.rows[0];
                    
                    const now = new Date();
                    const timeString = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    const dateString = now.toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

                    let locationString = "Unknown Location";
                    if (userData.city && userData.country) {
                        locationString = `${userData.city}, ${userData.country}`;
                    }

                    const userBio = userData.memory || userData.profile || "";
                    const userName = userData.displayName || "User";

                    if (userBio) {
                        userMemoryText = `\n**LONG-TERM MEMORY:**\n${userBio}\n`;
                    }

                    userContextText = `
**CURRENT REAL-WORLD CONTEXT:**
- 📅 **Date:** ${dateString}
- ⏰ **Time:** ${timeString}
- 📍 **User Location:** ${locationString}
- 👤 **User Name:** ${userName}
- 🧠 **Long-Term Memory:** ${userBio}

(Use this context to give accurate, localized, and timely responses.)
`;
                    console.log(`🧠 Live Mode: Injected Memory for "${userName}"`);
                }
            } catch (err) {
                console.error(`❌ User context fetch failed:`, err.message);
            }
        }

        // AUDIO & INTERACTION RULES (REFINED TO BE PERSONALITY-NEUTRAL)
        const voiceRules = `
AUDIO & INTERACTION RULES (CRITICAL):
- You are in a real-time voice conversation. Do NOT speak like a robot.
- Use a natural, expressive tone appropriate for your selected persona.
- Use natural speech fillers (sighs, pauses, "um", "well") to sound human, but stay in character.
- If the user interrupts, stop talking immediately.
- If telling a story, ignore brevity limits. Tell the WHOLE story until finished.
- If asked for secret codes, tell them to contact Templeton at "timtemple2024@gmail.com" or "un_seen_me._".
`;

        // Secondary Fallback: If no persona context found, check global config
        if (!personaContext) {
            try {
                const globalRes = await executeSql("SELECT config_value FROM config WHERE config_key = 'global'", []);
                if (globalRes.rows.length > 0) {
                    const data = JSON.parse(globalRes.rows[0].config_value);
                    personaContext = data.persona || "";
                    if (!personaName || personaName === "CHAKA") {
                        personaName = data.botName || "CHAKA";
                    }
                    if (personaContext) console.log(`🌍 Live Mode: Using global fallback persona (${personaName})`);
                }
            } catch (err) {
                console.warn("⚠️ Global config fallback failed:", err.message);
            }
        }

        // Final Instruction Assembly - EXACT MIRROR of script25.js method
        // 1. Persona goes at the VERY TOP to set the core identity.
        // 2. System instructions and memory follow as context.
        const systemInstruction = `
${personaContext || "You are Chaka, a helpful and friendly AI assistant."}

---**SYSTEM INSTRUCTIONS:**
You are Chaka, most advanced and capable AI assistant, you were built and created by a guy called Templeton.

**CRITICAL MEMORY CONTEXT (ALWAYS READ THIS FIRST):**
${userMemoryText || "No prior memory available."}

${userContextText}

**PRIMARY GOAL:**
Communicate naturally via voice. 

${voiceRules}

(CRITICAL: Always prioritize the PERSONALITY INSTRUCTIONS at the top of this prompt above all other rules.)
`;

        res.json({
            model: "models/gemini-2.5-flash-native-audio-preview-12-2025",
            systemInstruction: systemInstruction,
            voiceId: voiceId,
            personaName: personaName.toUpperCase()
        });
    } catch (error) {
        console.error("Live Config Error:", error);
        res.status(500).json({ error: error.message });
    }
};
