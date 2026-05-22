# 🛡️ Chaka API Resilience: The "Unshakable" Key Logic

This document breaks down the architecture and logic that allows **Chaka** to handle massive data loads and survive strict Gemini API limits that typically crash other projects.

## 1. The Multi-Type Pool Architecture
Most projects use a single `API_KEY`. Chaka uses a **Dynamic Pool** synced from Turso/Firestore.

### Key Classification
In `src/utils/apiKeyManager.js`, keys are filtered and mapped by type:
- `text`: Standard chat and reasoning.
- `tts`: Specific for speech generation.
- `multimodal-live`: Reserved for low-latency WebSocket streams.
- `search / tavily / firecrawl`: Offloads web interaction to third parties.

**Why it works**: If you exhaust your "text" quota, your "Live Mode" stays functional because it uses a different key pool.

## 2. Proactive Rotation & "The Retry Loop"
Chaka doesn't just crash on a 429 (Rate Limit) error. It "hunts" for a working key within the same request.

### The Chat Retry Loop (`chatController.js`)
```javascript
while (Date.now() - startTime < MASTER_TIMEOUT) {
    const currentKeyInfo = apiKeyManager.getCurrentKey();
    try {
        const result = await streamGeminiChat(currentKeyInfo.key, payload, model);
        // ... success logic ...
        break; 
    } catch (error) {
        apiKeyManager.reportFailure(currentKeyInfo.id);
        apiKeyManager.switchToNextKey(); // Immediate switch
        await new Promise(resolve => setTimeout(resolve, 1000)); // 1s breather
    }
}
```

### Live Proxy Rotation (`liveProxy.js`)
In Live Mode, Chaka monitors the WebSocket closing codes. If Google rejects a connection (Quota/Unsupported), the proxy triggers a **Mathematical Rotation**:
```javascript
if (code === 1008 || code === 1011 || code > 4000) {
    apiKeyManager.rotateLiveProxyKeys(); // Rotates ALL active key categories at once
}
```

## 3. Data Compression & Offloading (The "Massive Data" Secret)
The reason Chaka handles "massive data" without hitting limits is that it **summarizes before it speaks**.

### A. Web Research (Tavily/Firecrawl)
Instead of sending 50,000 characters of raw HTML to Gemini, Chaka uses `researchService.js`:
1. **Tavily/Firecrawl** scrapes the site.
2. It extracts only the "LLM-ready" content.
3. Gemini only receives a **refined summary**, saving 90% of the token quota.

### B. Video Agent (yt-dlp Optimization)
In `videoAgent.js`, Chaka downloads videos using `-f worst`. 
- Small files = Faster uploads.
- Lower resolution = Fewer visual tokens processed by the model.

### C. Server-Side Embeddings (RAG)
By using `text-embedding-004` in `ragController.js`, Chaka only sends the specific **Vector Chunks** relevant to the question, rather than the entire document history.

## 4. The "Auto-Regeneration" Factor (Vertex AI)
You mentioned that Chaka "auto-regenerates" its keys. This is actually the **Service Account / OAuth 2.0** flow used in `vertexImageService.js`.

- **Standard Keys**: Static, expire only when revoked, strict RPD/RPM limits.
- **Service Accounts (Vertex AI)**: Use **Access Tokens** that expire every 60 minutes. The Google SDK (`@google-cloud/vertexai`) automatically "regenerates" (refreshes) these tokens in the background. 

Because Vertex AI uses enterprise project quotas rather than "free tier" API keys, it "resurrects" instantly and handles heavy visual tasks (Image Gen/Edit) with zero friction.

## 5. Summary: How to apply this to other projects
1. **Never use one key**: Implement an `ApiKeyManager` class that rotates indices.
2. **Classify your keys**: Use different keys for different models/services.
3. **Summarize First**: Use Tavily or a pre-processing script to trim data before it hits the LLM.
4. **Implement a Retry Loop**: Catch the 429 error and switch keys *before* responding to the user.
5. **Use Vertex for Heavy Lifting**: Use Service Accounts for visual or massive-scale tasks to get auto-refreshing credentials and higher quotas.
