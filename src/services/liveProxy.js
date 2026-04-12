const WebSocket = require('ws');
const apiKeyManager = require('../utils/apiKeyManager');
const url = require('url');

// We create a standalone WebSocket server instance with no Server attached.
// This allows us to manually handle the 'upgrade' event from the HTTP server.
const wss = new WebSocket.Server({ noServer: true });

function handleLiveStreamUpgrade(request, socket, head) {
    console.log("🔗 Intercepting WebSocket upgrade for Gemini Live Proxy...");

    // Get the API key strictly from the 'multimodal-live', 'tts', or standard 'text' fallback
    const keyInfo = apiKeyManager.getMultimodalKey() || apiKeyManager.getTtsKey() || apiKeyManager.getCurrentKey();
    if (!keyInfo || !keyInfo.key) {
        console.warn("⚠️ Live Proxy: No Live, TTS, or Text keys found in Admin Panel. Refusing connection.");
        // Close with a normal custom code so the frontend knows it's intentionally disabled
        if (socket.readyState === socket.OPEN) {
            socket.close(1000, "No API Key Available");
        } else {
            socket.destroy();
        }
        return;
    }


    // Complete the WebSocket upgrade for the incoming client (browser)
    wss.handleUpgrade(request, socket, head, (clientWs) => {
        console.log("✅ Client browser connected to Live Proxy.");

        // Formulate the secure URL to Google Gemini using the hidden API key
        const googleWsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${keyInfo.key}`;
        
        console.log("🌍 Connecting secure backend socket to Google Gemini...");
        const googleWs = new WebSocket(googleWsUrl);

        // --- Connection Lifecycle ---
        googleWs.on('open', () => {
            console.log("🔓 Google Gemini WebSocket Opened via Proxy.");
            // We could optionally emit an event here to let the client know Google is ready
        });

        // 1. Browser -> Proxy -> Google
        clientWs.on('message', (message, isBinary) => {
            if (googleWs.readyState === WebSocket.OPEN) {
                // Pass the message directly to Google
                googleWs.send(message, { binary: isBinary });
            }
        });

        // 2. Google -> Proxy -> Browser
        googleWs.on('message', (message, isBinary) => {
            if (clientWs.readyState === WebSocket.OPEN) {
                // Pass the message directly back to the browser
                clientWs.send(message, { binary: isBinary });
            }
        });

        // --- Cleanup & Error Handling ---
        clientWs.on('close', (code, reason) => {
            console.log(`🔴 Client Browser disconnected (${code}).`);
            if (googleWs.readyState === WebSocket.OPEN) {
                googleWs.close(); // Close Gemini connection immediately to save tokens
            }
        googleWs.on('close', (code, reason) => {
            console.log(`🔴 Google Gemini closed connection (${code}): ${reason}`);

            // If Google disconnected prematurely with an error (e.g., quota, unsupported config)
            if (code === 1008 || code === 1011 || code > 4000) {
                console.warn(`⚠️ Google rejected the Live stream with code ${code}. Auto-rotating API keys...`);
                if (typeof apiKeyManager.rotateLiveProxyKeys === 'function') {
                    apiKeyManager.rotateLiveProxyKeys();
                }
            }

            if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.close(code, reason.toString() || 'Gemini Closed');
            }
        });

        clientWs.on('error', (err) => {
            console.error("⚠️ Client WS Error:", err.message);
        });

        googleWs.on('error', (err) => {
            console.error("⚠️ Google WS Error:", err.message);
            if (clientWs.readyState === WebSocket.OPEN) {
                // Inform the browser that the target failed
                clientWs.close(1011, 'Target Server Error');
            }
        });
    });
}

module.exports = { handleLiveStreamUpgrade };
