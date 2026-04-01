const express = require('express');
const { executeSql } = require('../services/tursoService');
const { broadcastToUser, broadcastGlobal } = require('../services/realtimeSockets');
const admin = require('firebase-admin');

const router = express.Router();

/**
 * Helper: Lazy Migration Logic
 * Ensures a user exists in Turso. If not, pulls their core data from Firestore.
 */
async function ensureUserMigrated(uid) {
  try {
    const userCheck = await executeSql('SELECT * FROM users WHERE firebase_uid = ?', [uid]);
    if (userCheck.rows.length === 0) {
      console.log(`🚚 User ${uid} not in Turso. Lazy Migrating from Firebase...`);
      let fbUser = null;
      try {
        const uDoc = await admin.firestore().collection('users').doc(uid).get();
        if (uDoc.exists) fbUser = uDoc.data();
      } catch (e) {
          console.warn("Could not fetch user from Firestore during migration.");
      }

      const personality = fbUser?.selectedPersonality || 'CHAKA';
      const email = fbUser?.email || '';
      const tourCompleted = fbUser?.tourCompleted ? 1 : 0;
      
      await executeSql(
        'INSERT INTO users (firebase_uid, email, personality, tourCompleted) VALUES (?, ?, ?, ?)',
        [uid, email, personality, tourCompleted]
      );
      console.log(`✅ Lazy Migrated user ${uid} to Turso.`);
    }
  } catch (error) {
    console.error('Lazy migration error:', error);
  }
}

// ═══════════════════════════════════════════════════════════
// USER ENDPOINTS
// ═══════════════════════════════════════════════════════════

// REST: Get User Profile
router.get('/users/:uid', async (req, res) => {
  const { uid } = req.params;
  await ensureUserMigrated(uid);
  try {
    const result = await executeSql('SELECT * FROM users WHERE firebase_uid = ?', [uid]);
    res.json(result.rows[0] || {});
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// REST: Get User Settings (tourCompleted, warnings, blocked, seenPersonalities)
router.get('/users/:uid/settings', async (req, res) => {
  const { uid } = req.params;
  await ensureUserMigrated(uid);
  try {
    const result = await executeSql(
      'SELECT tourCompleted, warnings, blocked, seenPersonalities, lastWarningAt FROM users WHERE firebase_uid = ?',
      [uid]
    );
    const row = result.rows[0] || {};
    res.json({
      tourCompleted: row.tourCompleted === 1,
      warnings: row.warnings || 0,
      blocked: row.blocked === 1,
      seenPersonalities: row.seenPersonalities ? JSON.parse(row.seenPersonalities) : [],
      lastWarningAt: row.lastWarningAt
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// REST: Update User Profile/Settings
router.patch('/users/:uid', async (req, res) => {
  const { uid } = req.params;
  const updates = req.body;
  await ensureUserMigrated(uid);
  
  try {
    const setClauses = [];
    const values = [];
    
    const allowedFields = {
      email: 'TEXT', displayName: 'TEXT', photoURL: 'TEXT', personality: 'TEXT',
      tourCompleted: 'BOOL', warnings: 'INT', lastWarningAt: 'TEXT',
      blocked: 'BOOL', seenPersonalities: 'JSON', location: 'JSON',
      device: 'JSON', lastLogin: 'TEXT'
    };
    
    for (const [key, type] of Object.entries(allowedFields)) {
      if (updates[key] !== undefined) {
        setClauses.push(`${key} = ?`);
        if (type === 'JSON') {
          values.push(typeof updates[key] === 'string' ? updates[key] : JSON.stringify(updates[key]));
        } else if (type === 'BOOL') {
          values.push(updates[key] ? 1 : 0);
        } else if (type === 'INT') {
          values.push(parseInt(updates[key]) || 0);
        } else {
          values.push(updates[key]);
        }
      }
    }
    
    if (setClauses.length === 0) {
      return res.json({ success: true, message: 'No fields to update' });
    }
    
    values.push(uid);
    await executeSql(`UPDATE users SET ${setClauses.join(', ')} WHERE firebase_uid = ?`, values);
    
    res.json({ success: true });
  } catch (e) {
    console.error('PATCH /users error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════
// SESSION ENDPOINTS
// ═══════════════════════════════════════════════════════════

// REST: Get Sessions
router.get('/sessions/:uid', async (req, res) => {
  const { uid } = req.params;
  await ensureUserMigrated(uid);
  try {
    const result = await executeSql(
      'SELECT * FROM sessions WHERE user_uid = ? ORDER BY updatedAt DESC',
      [uid]
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// REST: Create or Update Session
router.post('/sessions/:uid', async (req, res) => {
  const { uid } = req.params;
  const { session_id, title, personalityId } = req.body;
  
  try {
    await ensureUserMigrated(uid);

    await executeSql(
      'INSERT OR REPLACE INTO sessions (session_id, user_uid, title, personalityId, updatedAt) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)',
      [session_id, uid, title || 'New Chat', personalityId || 'CHAKA']
    );
    
    const newSession = { session_id, user_uid: uid, title, personalityId };
    broadcastToUser(uid, 'SESSION_ADDED', newSession);
    
    res.json(newSession);
  } catch (e) {
    console.error('POST /sessions error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// REST: Update Session Title
router.patch('/sessions/:uid/:sessionId', async (req, res) => {
  const { uid, sessionId } = req.params;
  const { title, blocked, blockedBy, blockReason, wasBlocked, lastSubtleNote, warnings } = req.body;
  
  try {
    const setClauses = [];
    const values = [];
    
    if (title !== undefined) { setClauses.push('title = ?'); values.push(title); }
    if (blocked !== undefined) { setClauses.push('blocked = ?'); values.push(blocked ? 1 : 0); }
    if (blockedBy !== undefined) { setClauses.push('blockedBy = ?'); values.push(blockedBy); }
    if (blockReason !== undefined) { setClauses.push('blockReason = ?'); values.push(blockReason); }
    if (wasBlocked !== undefined) { setClauses.push('wasBlocked = ?'); values.push(wasBlocked ? 1 : 0); }
    if (lastSubtleNote !== undefined) { setClauses.push('lastSubtleNote = ?'); values.push(typeof lastSubtleNote === 'string' ? lastSubtleNote : JSON.stringify(lastSubtleNote)); }
    if (warnings !== undefined) { setClauses.push('warnings = ?'); values.push(warnings); }
    
    setClauses.push('updatedAt = CURRENT_TIMESTAMP');
    
    values.push(sessionId, uid);
    await executeSql(
      `UPDATE sessions SET ${setClauses.join(', ')} WHERE session_id = ? AND user_uid = ?`,
      values
    );
    
    broadcastToUser(uid, 'SESSION_UPDATED', { session_id: sessionId, title });
    
    res.json({ success: true, title });
  } catch (e) {
    console.error('PATCH /sessions error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// REST: Get Session Details (for checking blocked status etc.)
router.get('/sessions/:uid/:sessionId', async (req, res) => {
  const { uid, sessionId } = req.params;
  try {
    const result = await executeSql(
      'SELECT * FROM sessions WHERE session_id = ? AND user_uid = ?',
      [sessionId, uid]
    );
    res.json(result.rows[0] || {});
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════
// CHAT ENDPOINTS
// ═══════════════════════════════════════════════════════════

// REST: Get Chats for a Session
router.get('/chats/:uid/:sessionId', async (req, res) => {
  const { uid, sessionId } = req.params;
  try {
    const result = await executeSql(
      'SELECT * FROM chats WHERE session_id = ? ORDER BY createdAt ASC',
      [sessionId]
    );
    const formattedChats = result.rows.map(row => ({
      ...row,
      internal: row.internal === 1,
      imageUrls: row.image_urls ? JSON.parse(row.image_urls) : null,
      attachedFiles: row.attached_files ? JSON.parse(row.attached_files) : null
    }));
    res.json(formattedChats);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// REST: Save a Chat Message
router.post('/chats/:uid/:sessionId', async (req, res) => {
  const { uid, sessionId } = req.params;
  const { message_id, sender, text, image_urls, attached_files, internal } = req.body;
  const isInternal = internal ? 1 : 0;
  
  try {
    await ensureUserMigrated(uid);

    const sessionCheck = await executeSql('SELECT session_id FROM sessions WHERE session_id = ?', [sessionId]);
    if (sessionCheck.rows.length === 0) {
      console.log(`🔧 Auto-creating session ${sessionId} for user ${uid}`);
      await executeSql(
        'INSERT INTO sessions (session_id, user_uid, title, personalityId, updatedAt) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)',
        [sessionId, uid, 'New Chat', 'CHAKA']
      );
    }

    await executeSql(
      'INSERT INTO chats (message_id, session_id, user_uid, sender, text, image_urls, attached_files, internal) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [message_id, sessionId, uid, sender, text || '', image_urls ? JSON.stringify(image_urls) : null, attached_files ? JSON.stringify(attached_files) : null, isInternal]
    );
    
    const newMsg = { message_id, session_id: sessionId, user_uid: uid, sender, text, imageUrls: image_urls, attachedFiles: attached_files, internal: isInternal === 1 };
    
    await executeSql('UPDATE sessions SET updatedAt = CURRENT_TIMESTAMP WHERE session_id = ?', [sessionId]);

    broadcastToUser(uid, 'CHAT_ADDED', newMsg);
    broadcastToUser(uid, 'SESSION_UPDATED', { session_id: sessionId });

    res.json(newMsg);
  } catch (e) {
    console.error('POST /chats error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════
// CONFIG ENDPOINTS (replaces Firestore config/global)
// ═══════════════════════════════════════════════════════════

// REST: Get Global Config
router.get('/config', async (req, res) => {
  try {
    const result = await executeSql('SELECT * FROM config');
    const config = {};
    for (const row of result.rows) {
      try { config[row.config_key] = JSON.parse(row.config_value); }
      catch { config[row.config_key] = row.config_value; }
    }
    
    // If Turso config is empty, try to pull from Firestore (one-time migration)
    if (Object.keys(config).length === 0) {
      console.log('📦 No config in Turso, attempting one-time migration from Firestore...');
      try {
        const cfgDoc = await admin.firestore().collection('config').doc('global').get();
        if (cfgDoc.exists) {
          const fbConfig = cfgDoc.data();
          // Save entire config as a single 'global' key
          await executeSql(
            'INSERT OR REPLACE INTO config (config_key, config_value, updatedAt) VALUES (?, ?, CURRENT_TIMESTAMP)',
            ['global', JSON.stringify(fbConfig)]
          );
          console.log('✅ Config migrated from Firestore to Turso.');
          return res.json(fbConfig);
        }
      } catch (fbErr) {
        console.warn('Firestore config migration failed:', fbErr.message);
      }
    }
    
    // Return the 'global' config object if it exists
    res.json(config.global || config);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// REST: Update Global Config (admin)
router.put('/config', async (req, res) => {
  try {
    const configData = req.body;
    await executeSql(
      'INSERT OR REPLACE INTO config (config_key, config_value, updatedAt) VALUES (?, ?, CURRENT_TIMESTAMP)',
      ['global', JSON.stringify(configData)]
    );
    broadcastGlobal('CONFIG_UPDATED', configData);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════
// PERSONALITY ENDPOINTS (replaces Firestore personalities collection)
// ═══════════════════════════════════════════════════════════

// REST: Get All Personalities
router.get('/personalities', async (req, res) => {
  try {
    const result = await executeSql('SELECT * FROM personalities WHERE enabled = 1 ORDER BY sortOrder ASC, createdAt DESC');
    
    // If Turso personalities empty, try one-time Firestore migration
    if (result.rows.length === 0) {
      console.log('📦 No personalities in Turso, attempting one-time migration from Firestore...');
      try {
        const pSnap = await admin.firestore().collection('personalities').get();
        if (!pSnap.empty) {
          for (const pDoc of pSnap.docs) {
            const p = pDoc.data();
            await executeSql(
              `INSERT OR REPLACE INTO personalities (id, name, description, icon, systemPrompt, welcomeMessage, avatarUrl, videoUrl, isDefault, enabled, sortOrder, createdAt)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                pDoc.id, p.name || '', p.description || '', p.icon || '', p.persona || p.systemPrompt || '',
                p.welcomeMessage || '', p.avatarUrl || p.avatar || '', p.videoUrl || '', p.isDefault ? 1 : 0,
                p.enabled !== false ? 1 : 0, p.sortOrder || 0,
                p.createdAt?.toDate?.()?.toISOString?.() || new Date().toISOString()
              ]
            );
          }
          console.log(`✅ Migrated ${pSnap.size} personalities from Firestore to Turso.`);
          const migrated = await executeSql('SELECT * FROM personalities WHERE enabled = 1 ORDER BY sortOrder ASC, createdAt DESC');
          return res.json(migrated.rows);
        }
      } catch (fbErr) {
        console.warn('Firestore personality migration failed:', fbErr.message);
      }
    }
    
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// REST: Create/Update a Personality (admin)
router.post('/personalities', async (req, res) => {
  const { id, name, icon, systemPrompt, welcomeMessage, avatarUrl, isDefault, enabled, sortOrder } = req.body;
  try {
    await executeSql(
      `INSERT OR REPLACE INTO personalities (id, name, icon, systemPrompt, welcomeMessage, avatarUrl, isDefault, enabled, sortOrder, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT createdAt FROM personalities WHERE id = ?), CURRENT_TIMESTAMP))`,
      [id, name || '', icon || '', systemPrompt || '', welcomeMessage || '', avatarUrl || '', isDefault ? 1 : 0, enabled !== false ? 1 : 0, sortOrder || 0, id]
    );
    res.json({ success: true, id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// REST: Delete a Personality (admin)
router.delete('/personalities/:id', async (req, res) => {
  try {
    await executeSql('DELETE FROM personalities WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════
// ANNOUNCEMENT ENDPOINTS (replaces Firestore announcements/latest)
// ═══════════════════════════════════════════════════════════

// REST: Get Latest Announcement
router.get('/announcements/latest', async (req, res) => {
  try {
    const result = await executeSql('SELECT * FROM announcements WHERE active = 1 ORDER BY createdAt DESC LIMIT 1');
    
    // If no announcements in Turso, try Firestore migration
    if (result.rows.length === 0) {
      try {
        const aDoc = await admin.firestore().collection('announcements').doc('latest').get();
        if (aDoc.exists) {
          const a = aDoc.data();
          await executeSql(
            'INSERT OR REPLACE INTO announcements (id, title, description, fullContent, mediaUrl, mediaType, type, active, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)',
            ['latest', a.title || '', a.description || '', a.fullContent || '', a.mediaUrl || '', a.mediaType || 'image', a.type || 'info', (a.isActive !== false && a.active !== false) ? 1 : 0]
          );
          return res.json({ id: 'latest', ...a });
        }
      } catch (fbErr) {
        console.warn('Firestore announcement migration failed:', fbErr.message);
      }
    }
    
    res.json(result.rows[0] || null);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// REST: Create/Update Announcement (admin)
router.post('/announcements', async (req, res) => {
  const { id, title, description, fullContent, mediaUrl, mediaType, type, active } = req.body;
  try {
    const announcementId = id || 'latest';
    await executeSql(
      'INSERT OR REPLACE INTO announcements (id, title, description, fullContent, mediaUrl, mediaType, type, active, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)',
      [announcementId, title || '', description || '', fullContent || '', mediaUrl || '', mediaType || 'image', type || 'info', active !== false ? 1 : 0]
    );
    res.json({ success: true, id: announcementId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════
// RAG CHUNKS ENDPOINTS (replaces Firestore vectorChunks subcollection)
// ═══════════════════════════════════════════════════════════

// REST: Get All Chunks for a User
router.get('/chunks/:uid', async (req, res) => {
  const { uid } = req.params;
  try {
    const result = await executeSql('SELECT * FROM vector_chunks WHERE user_uid = ? ORDER BY createdAt ASC', [uid]);
    const chunks = result.rows.map(row => ({
      chunk_id: row.chunk_id,
      fileId: row.fileId,
      text: row.text,
      metadata: row.metadata ? JSON.parse(row.metadata) : {}
    }));
    res.json(chunks);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// REST: Save RAG Chunks (batch)
router.post('/chunks/:uid', async (req, res) => {
  const { uid } = req.params;
  const { chunks } = req.body; // Array of { chunk_id, fileId, text, metadata }
  
  try {
    for (const chunk of chunks) {
      await executeSql(
        'INSERT OR REPLACE INTO vector_chunks (chunk_id, user_uid, fileId, text, metadata) VALUES (?, ?, ?, ?, ?)',
        [chunk.chunk_id || crypto.randomUUID(), uid, chunk.fileId || '', chunk.text || '', chunk.metadata ? JSON.stringify(chunk.metadata) : '{}']
      );
    }
    res.json({ success: true, count: chunks.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// REST: Delete Chunks by fileId
router.delete('/chunks/:uid/:fileId', async (req, res) => {
  const { uid, fileId } = req.params;
  try {
    const result = await executeSql('DELETE FROM vector_chunks WHERE user_uid = ? AND fileId = ?', [uid, fileId]);
    res.json({ success: true, deleted: result.rowsAffected || 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════
// SYNC ENDPOINT (Admin Panel Bridge)
// Forces re-sync of Firestore data to Turso
// ═══════════════════════════════════════════════════════════
router.post('/sync/:type', async (req, res) => {
  const { type } = req.params;
  try {
    const db = admin.firestore();

    if (type === 'config') {
      const cfgDoc = await db.collection('config').doc('global').get();
      if (cfgDoc.exists) {
        const data = cfgDoc.data();
        const jsonData = JSON.stringify(data);
        await executeSql(
          `INSERT INTO config (config_key, config_value, updatedAt) VALUES ('global', ?, datetime('now')) ON CONFLICT(config_key) DO UPDATE SET config_value = ?, updatedAt = datetime('now')`,
          [jsonData, jsonData]
        );
        broadcastGlobal('CONFIG_UPDATED', data);
      }
      return res.json({ success: true, synced: 'config' });
    }

    if (type === 'personalities') {
      const snap = await db.collection('personalities').get();
      for (const doc of snap.docs) {
        const p = doc.data();
        await executeSql(
          `INSERT INTO personalities (id, name, description, systemPrompt, avatarUrl, videoUrl, isDefault, createdAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET name=?, description=?, systemPrompt=?, avatarUrl=?, videoUrl=?, isDefault=?`,
          [
            doc.id, p.name || '', p.description || '', p.persona || p.systemPrompt || '',
            p.avatarUrl || p.avatar || '', p.videoUrl || '', p.isDefault ? 1 : 0,
            p.createdAt?.toDate?.()?.toISOString() || new Date().toISOString(),
            p.name || '', p.description || '', p.persona || p.systemPrompt || '',
            p.avatarUrl || p.avatar || '', p.videoUrl || '', p.isDefault ? 1 : 0
          ]
        );
      }
      // Also delete personalities in Turso that no longer exist in Firestore
      const firestoreIds = snap.docs.map(d => d.id);
      if (firestoreIds.length > 0) {
        const tursoResult = await executeSql('SELECT id FROM personalities', []);
        for (const row of tursoResult.rows) {
          if (!firestoreIds.includes(row.id)) {
            await executeSql('DELETE FROM personalities WHERE id = ?', [row.id]);
          }
        }
      }
      return res.json({ success: true, synced: 'personalities', count: snap.docs.length });
    }

    if (type === 'announcements') {
      const annoDoc = await db.collection('announcements').doc('latest').get();
      if (annoDoc.exists) {
        const a = annoDoc.data();
        await executeSql(
          `INSERT INTO announcements (id, title, description, fullContent, mediaUrl, mediaType, active, createdAt)
           VALUES ('latest', ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET title=?, description=?, fullContent=?, mediaUrl=?, mediaType=?, active=?`,
          [
            a.title || '', a.description || '', a.fullContent || '',
            a.mediaUrl || '', a.mediaType || 'image', a.isActive !== false ? 1 : 0,
            a.createdAt?.toDate?.()?.toISOString() || new Date().toISOString(),
            a.title || '', a.description || '', a.fullContent || '',
            a.mediaUrl || '', a.mediaType || 'image', a.isActive !== false ? 1 : 0
          ]
        );
      }
      return res.json({ success: true, synced: 'announcements' });
    }

    res.status(400).json({ error: 'Unknown sync type. Use: config, personalities, announcements' });
  } catch (e) {
    console.error(`Sync error (${type}):`, e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
