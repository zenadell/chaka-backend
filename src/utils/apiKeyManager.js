const { executeSql } = require('../services/tursoService');

class ApiKeyManager {
  constructor() {
    this.keys = [];
    this.currentIndex = 0;
    this.currentTtsIndex = 0;
    this.currentLiveIndex = 0;
    this.usageTimestamps = new Map();
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;

    console.log("🔄 Initializing API Key Manager from Turso...");
    await this.reloadConfig();
    this.initialized = true;
  }

  async reloadConfig() {
    try {
      const result = await executeSql('SELECT config_value FROM config WHERE config_key = ?', ['global']);
      if (result.rows.length === 0) {
        console.warn("⚠️ Config document 'global' not found in Turso.");
        return;
      }
      const data = JSON.parse(result.rows[0].config_value);
      const apiKeysConfig = data.apiKeys || {};

      // ✅ BUG FIX: Removed "val.type === 'text'" check.
      // Now it loads ALL enabled keys (Search, Image, TTS, Text).
      this.keys = Object.entries(apiKeysConfig)
        .filter(([, val]) => val && val.enabled !== false && val.key)
        .map(([id, val]) => ({
          id,
          key: val.key.trim(),
          type: val.type || 'text',
          voiceId: val.voiceId || null
        }));

      // Reset usage trackers
      this.keys.forEach(k => {
        if (!this.usageTimestamps.has(k.id)) {
          this.usageTimestamps.set(k.id, []);
        }
      });

      // Reset indices
      if (this.currentIndex >= this.keys.length) this.currentIndex = 0;
      if (this.currentTtsIndex >= this.keys.length) this.currentTtsIndex = 0;
      if (this.currentLiveIndex >= this.keys.length) this.currentLiveIndex = 0;

      console.log(`✅ API Key Manager updated: ${this.keys.length} active keys available.`);

      // Debug print to confirm types are loaded
      const types = this.keys.map(k => k.type);
      console.log("   Loaded types:", types.join(', '));

    } catch (error) {
      console.error("❌ Error loading config for API Keys:", error.message);
    }
  }

  // Gets the current TEXT key for chat
  getCurrentKey() {
    // Filter for text keys only for the rotation logic
    const textKeys = this.keys.filter(k => k.type === 'text');
    if (textKeys.length === 0) return null;

    // Safety check for index
    if (this.currentIndex >= textKeys.length) this.currentIndex = 0;

    return { ...textKeys[this.currentIndex], index: this.currentIndex };
  }

  switchToNextKey() {
    const textKeys = this.keys.filter(k => k.type === 'text');
    if (textKeys.length === 0) return null;

    const oldIndex = this.currentIndex;
    this.currentIndex = (this.currentIndex + 1) % textKeys.length;
    console.warn(`🔄 Switching Chat API key from index ${oldIndex} to ${this.currentIndex}.`);
    return this.getCurrentKey();
  }

  recordUsage(keyId) {
    if (!this.usageTimestamps.has(keyId)) return;
    const now = Date.now();
    const timestamps = this.usageTimestamps.get(keyId);
    timestamps.push(now);
    const validTimestamps = timestamps.filter(ts => ts > now - 60000);
    this.usageTimestamps.set(keyId, validTimestamps);
    this.updateLiveStatus(keyId).catch(() => { });
  }

  async updateLiveStatus(keyId) {
    // Optionally log to Turso or ignore since it's an admin dashboard feature
    // For now we just skip the Firestore write
  }

  async reportFailure(keyId) {
    console.warn(`⚠️ API Key Failure reported for keyId: ${keyId}`);
  }

  // Gets first available TTS key (with rotation)
  getTtsKey() {
    const ttsKeys = this.keys.filter(k => k.type === 'tts');
    if (ttsKeys.length === 0) return null;
    if (this.currentTtsIndex >= ttsKeys.length) this.currentTtsIndex = 0;
    return ttsKeys[this.currentTtsIndex];
  }

  // Gets first available Multimodal Live key (with rotation)
  getMultimodalKey() {
    const mmKeys = this.keys.filter(k => k.type === 'multimodal-live');
    if (mmKeys.length === 0) return null;
    if (this.currentLiveIndex >= mmKeys.length) this.currentLiveIndex = 0;
    return mmKeys[this.currentLiveIndex];
  }

  // Phase 5.7+: generic helper for any provider type.
  // Returns an array of { id, key, type } for all enabled keys matching `type`.
  // Used by stagehandService + deepResearchService to load groq/cerebras/
  // sambanova/openrouter keys from admin → Turso instead of Render env vars.
  getKeysByType(type) {
    return this.keys.filter(k => k.type === type && k.key);
  }

  // Pick one key for a provider — random rotation if multiple are present,
  // so the load is spread across the pool without state.
  pickKey(type) {
    const pool = this.getKeysByType(type);
    if (!pool.length) return null;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  // Rotates whatever keys the Live Proxy is attempting to use
  rotateLiveProxyKeys() {
    const ttsKeys = this.keys.filter(k => k.type === 'tts');
    if (ttsKeys.length > 0) this.currentTtsIndex = (this.currentTtsIndex + 1) % ttsKeys.length;
    
    const mmKeys = this.keys.filter(k => k.type === 'multimodal-live');
    if (mmKeys.length > 0) this.currentLiveIndex = (this.currentLiveIndex + 1) % mmKeys.length;

    // Also rotate fallback text keys
    this.switchToNextKey();
    
    console.warn(`🔄 Live Proxy keys mathematically rotated to prevent stale/broken key loops.`);
  }
}

module.exports = new ApiKeyManager();
