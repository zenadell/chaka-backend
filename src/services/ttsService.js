const axios = require('axios');

const MODEL_NAME = 'gemini-2.5-flash-preview-tts';

/**
 * Generates speech audio using Google Gemini Native TTS.
 * Returns a WAV audio buffer (PCM 24kHz, 16-bit, mono with WAV header).
 *
 * @param {string} text     - Text to speak
 * @param {string} apiKey   - Google AI API key
 * @param {string} voiceId  - Gemini voice name (Puck, Kore, Zephyr, Charon)
 * @returns {Buffer} WAV audio buffer
 */
async function generateSpeech(text, apiKey, voiceId) {
    // Default to Puck if no voice configured
    const voiceName = voiceId || 'Puck';

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent?key=${apiKey}`;

    const requestBody = {
        contents: [{ parts: [{ text }] }],
        generationConfig: {
            responseModalities: ['audio'],
            speechConfig: {
                voiceConfig: {
                    prebuiltVoiceConfig: { voiceName }
                }
            }
        }
    };

    try {
        const response = await axios.post(url, requestBody, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 30000
        });

        const data = response.data;

        // Validate response shape
        const inlineData = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData;
        if (!inlineData || !inlineData.data) {
            console.error('❌ Gemini TTS unexpected response:', JSON.stringify(data).substring(0, 500));
            throw new Error('Gemini TTS returned no audio data.');
        }

        // Convert base64 PCM → raw bytes
        const pcmBuffer = Buffer.from(inlineData.data, 'base64');

        // Wrap raw PCM in a WAV header (24kHz, 16-bit, mono)
        const wavBuffer = addWavHeader(pcmBuffer, 24000, 16, 1);

        console.log(`✅ Gemini TTS generated ${wavBuffer.length} bytes (voice: ${voiceName})`);
        return wavBuffer;

    } catch (error) {
        if (error.response) {
            const status = error.response.status;
            let body = error.response.data;
            try {
                body = typeof body === 'object' ? JSON.stringify(body) : String(body);
            } catch (_e) {
                body = String(body);
            }
            const msg = `TTS provider error (status=${status}): ${body}`;
            const err = new Error(msg);
            err.status = status;
            throw err;
        }
        throw new Error(error.message || 'Unknown TTS error');
    }
}

/**
 * Wraps raw PCM samples in a standard WAV (RIFF) header so browsers
 * and audio players can decode it.
 */
function addWavHeader(samples, sampleRate, sampleBits, numChannels) {
    const dataLength = samples.length;
    const headerSize = 44;
    const buffer = Buffer.alloc(headerSize + dataLength);

    // RIFF chunk descriptor
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + dataLength, 4);
    buffer.write('WAVE', 8);

    // fmt sub-chunk
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);                                          // Sub-chunk size
    buffer.writeUInt16LE(1, 20);                                           // Audio format (PCM)
    buffer.writeUInt16LE(numChannels, 22);                                 // Channels
    buffer.writeUInt32LE(sampleRate, 24);                                  // Sample rate
    buffer.writeUInt32LE(sampleRate * numChannels * (sampleBits / 8), 28); // Byte rate
    buffer.writeUInt16LE(numChannels * (sampleBits / 8), 32);             // Block align
    buffer.writeUInt16LE(sampleBits, 34);                                  // Bits per sample

    // data sub-chunk
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataLength, 40);
    samples.copy(buffer, headerSize);

    return buffer;
}

module.exports = { generateSpeech, generateSpeechRaw };

/**
 * Generates raw PCM base64 string using Google Gemini Native TTS.
 * Useful for frontend streaming via AudioContext.
 */
async function generateSpeechRaw(text, apiKey, voiceId) {
    const voiceName = voiceId || 'Puck';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent?key=${apiKey}`;

    const requestBody = {
        contents: [{ parts: [{ text }] }],
        generationConfig: {
            responseModalities: ['audio'],
            speechConfig: {
                voiceConfig: {
                    prebuiltVoiceConfig: { voiceName }
                }
            }
        }
    };

    const response = await axios.post(url, requestBody, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 30000
    });

    const base64Data = response.data?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!base64Data) throw new Error('Gemini TTS returned no audio data.');

    return base64Data;
}
