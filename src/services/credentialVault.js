/**
 * credentialVault.js — Phase 4E: Encrypted Credential Vault
 *
 * Stores user credentials (IG, WhatsApp, GitHub tokens, etc.) encrypted in Turso.
 * The agent retrieves them as Stagehand `variables` so they're never logged
 * in plaintext and the LLM only sees variable names, not values.
 *
 * Encryption: AES-256-GCM with a server key from CREDENTIAL_VAULT_KEY env var.
 * If the env var is missing, the service uses a derived key (less secure but
 * still better than plaintext) and warns the operator.
 */

const crypto = require('crypto');
const { executeSql } = require('./tursoService');

const ALGO = 'aes-256-gcm';
const KEY_LEN = 32;

let cachedKey = null;
function getMasterKey() {
  if (cachedKey) return cachedKey;
  const envKey = process.env.CREDENTIAL_VAULT_KEY;
  if (envKey && envKey.length >= 32) {
    cachedKey = crypto.scryptSync(envKey, 'chaka-vault-salt', KEY_LEN);
  } else {
    // Fallback derived key — warn so the operator sets a proper one
    console.warn('⚠️  CREDENTIAL_VAULT_KEY env var missing or too short. Using derived fallback.');
    const fallback = (process.env.TURSO_AUTH_TOKEN || 'chaka-fallback-key') + ':vault';
    cachedKey = crypto.scryptSync(fallback, 'chaka-vault-salt', KEY_LEN);
  }
  return cachedKey;
}

function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, getMasterKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: base64(iv).base64(tag).base64(ciphertext)
  return `${iv.toString('base64')}.${tag.toString('base64')}.${encrypted.toString('base64')}`;
}

function decrypt(ciphertext) {
  try {
    const [ivB64, tagB64, ctB64] = ciphertext.split('.');
    if (!ivB64 || !tagB64 || !ctB64) throw new Error('Bad ciphertext format');
    const iv = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    const ct = Buffer.from(ctB64, 'base64');
    const decipher = crypto.createDecipheriv(ALGO, getMasterKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch (e) {
    throw new Error(`Decryption failed: ${e.message}`);
  }
}

// ── Schema ──────────────────────────────────────────────────────────────────
async function ensureSchema() {
  await executeSql(`
    CREATE TABLE IF NOT EXISTS credentials (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      service TEXT NOT NULL,
      keyName TEXT NOT NULL,
      valueEnc TEXT NOT NULL,
      description TEXT,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(userId, service, keyName)
    )
  `).catch(() => {}); // table-exists is fine
  await executeSql(`CREATE INDEX IF NOT EXISTS idx_credentials_user_service ON credentials(userId, service)`).catch(() => {});
}

// ── CRUD ────────────────────────────────────────────────────────────────────

async function setCredential({ userId, service, keyName, value, description }) {
  if (!userId || !service || !keyName || value == null) {
    throw new Error('userId, service, keyName, and value are required');
  }
  await ensureSchema();
  const id = `cred_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const enc = encrypt(String(value));

  // Upsert via insert-or-replace on the unique (userId, service, keyName) tuple
  await executeSql(`
    INSERT INTO credentials (id, userId, service, keyName, valueEnc, description, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(userId, service, keyName) DO UPDATE SET
      valueEnc = excluded.valueEnc,
      description = excluded.description,
      updatedAt = datetime('now')
  `, [id, userId, service.toLowerCase(), keyName, enc, description || null]);

  return { ok: true, id, service: service.toLowerCase(), keyName };
}

async function deleteCredential({ userId, service, keyName }) {
  await ensureSchema();
  await executeSql(
    `DELETE FROM credentials WHERE userId = ? AND service = ? AND keyName = ?`,
    [userId, service.toLowerCase(), keyName]
  );
  return { ok: true };
}

/**
 * List credentials for a user, optionally filtered by service.
 * SAFE — values are returned only as { hasValue: true, length: n } so the API
 * surface doesn't leak secrets even with full DB read.
 */
async function listCredentials({ userId, service }) {
  await ensureSchema();
  const sql = service
    ? `SELECT id, service, keyName, description, createdAt, updatedAt FROM credentials WHERE userId = ? AND service = ? ORDER BY service, keyName`
    : `SELECT id, service, keyName, description, createdAt, updatedAt FROM credentials WHERE userId = ? ORDER BY service, keyName`;
  const args = service ? [userId, service.toLowerCase()] : [userId];
  const res = await executeSql(sql, args);
  return res.rows.map(r => ({
    id: r.id,
    service: r.service,
    keyName: r.keyName,
    description: r.description || null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

/**
 * Get a single decrypted credential value. INTERNAL USE — only the agent
 * service calls this when running a task. Never exposed over HTTP.
 */
async function getCredentialValue({ userId, service, keyName }) {
  await ensureSchema();
  const res = await executeSql(
    `SELECT valueEnc FROM credentials WHERE userId = ? AND service = ? AND keyName = ?`,
    [userId, service.toLowerCase(), keyName]
  );
  if (!res.rows.length) return null;
  return decrypt(res.rows[0].valueEnc);
}

/**
 * Get all credentials for a user+service as a `variables` object suitable
 * for Stagehand's `variables` field. Values are decrypted in-memory only.
 *
 * Returns: { username: { value, description }, password: { value, description }, ... }
 */
async function getServiceVariables({ userId, service }) {
  await ensureSchema();
  const res = await executeSql(
    `SELECT keyName, valueEnc, description FROM credentials WHERE userId = ? AND service = ?`,
    [userId, service.toLowerCase()]
  );
  const variables = {};
  for (const row of res.rows) {
    try {
      variables[row.keyName] = {
        value: decrypt(row.valueEnc),
        description: row.description || `${service} ${row.keyName}`,
      };
    } catch (e) {
      console.warn(`[credentialVault] failed to decrypt ${service}/${row.keyName}: ${e.message}`);
    }
  }
  return variables;
}

module.exports = {
  setCredential,
  deleteCredential,
  listCredentials,
  getCredentialValue,
  getServiceVariables,
  ensureSchema,
  // exposed for tests only
  _encrypt: encrypt,
  _decrypt: decrypt,
};
