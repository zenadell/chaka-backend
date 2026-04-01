const { executeSql } = require('../services/tursoService');

class ApiKeyManager {
  constructor() {
    this.keys = [];
    this.currentIndex = 0;
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

      // Reset index
      if (this.currentIndex >= this.keys.length) {
        this.currentIndex = 0;
      }

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

  // Gets first available TTS key
  getTtsKey() {
    const ttsKeys = this.keys.filter(k => k.type === 'tts');
    return ttsKeys.length > 0 ? ttsKeys[0] : null;
  }

  // Gets first available Multimodal Live key
  getMultimodalKey() {
    const mmKeys = this.keys.filter(k => k.type === 'multimodal-live');
    return mmKeys.length > 0 ? mmKeys[0] : null;
  }
}

module.exports = new ApiKeyManager();
