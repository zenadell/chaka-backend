const { executeSql } = require('./tursoService');

async function initializeTursoSchema() {
  console.log('🔄 Verifying Turso Schema...');

  const schemaStatements = [
    // 1. Users Table (Linked to Firebase Auth UID)
    `CREATE TABLE IF NOT EXISTS users (
      firebase_uid TEXT PRIMARY KEY,
      email TEXT,
      displayName TEXT,
      photoURL TEXT,
      personality TEXT DEFAULT 'CHAKA',
      tourCompleted BOOLEAN DEFAULT 0,
      warnings INTEGER DEFAULT 0,
      lastWarningAt DATETIME,
      blocked BOOLEAN DEFAULT 0,
      seenPersonalities TEXT,
      location TEXT,
      device TEXT,
      lastLogin DATETIME DEFAULT CURRENT_TIMESTAMP,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    );`,

    // 2. Chat Sessions Table
    `CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      user_uid TEXT NOT NULL,
      title TEXT,
      personalityId TEXT,
      blocked BOOLEAN DEFAULT 0,
      blockedBy TEXT,
      blockReason TEXT,
      wasBlocked BOOLEAN DEFAULT 0,
      lastBlockedAt DATETIME,
      lastSubtleNote TEXT,
      warnings INTEGER DEFAULT 0,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_uid) REFERENCES users(firebase_uid)
    );`,

    `CREATE INDEX IF NOT EXISTS idx_sessions_list ON sessions(user_uid, personalityId, updatedAt DESC);`,

    // 3. Chat Messages Table
    `CREATE TABLE IF NOT EXISTS chats (
      message_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      user_uid TEXT NOT NULL,
      sender TEXT NOT NULL,
      text TEXT,
      image_urls TEXT,
      attached_files TEXT,
      internal BOOLEAN DEFAULT 0,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(session_id) REFERENCES sessions(session_id),
      FOREIGN KEY(user_uid) REFERENCES users(firebase_uid)
    );`,

    `CREATE INDEX IF NOT EXISTS idx_chats_session ON chats(session_id, createdAt ASC);`,

    // 4. Vector Chunks (For RAG)
    `CREATE TABLE IF NOT EXISTS vector_chunks (
      chunk_id TEXT PRIMARY KEY,
      user_uid TEXT NOT NULL,
      fileId TEXT,
      text TEXT NOT NULL,
      metadata TEXT,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_uid) REFERENCES users(firebase_uid)
    );`,

    `CREATE INDEX IF NOT EXISTS idx_chunks_user ON vector_chunks(user_uid);`,
    `CREATE INDEX IF NOT EXISTS idx_chunks_file ON vector_chunks(user_uid, fileId);`,

    // 5. Global Config (replaces Firestore config/global doc)
    `CREATE TABLE IF NOT EXISTS config (
      config_key TEXT PRIMARY KEY,
      config_value TEXT NOT NULL,
      updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
    );`,

    // 6. Personalities (replaces Firestore personalities collection)
    `CREATE TABLE IF NOT EXISTS personalities (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      icon TEXT,
      systemPrompt TEXT,
      welcomeMessage TEXT,
      avatarUrl TEXT,
      videoUrl TEXT,
      isDefault BOOLEAN DEFAULT 0,
      enabled BOOLEAN DEFAULT 1,
      sortOrder INTEGER DEFAULT 0,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    );`,

    // 7. Announcements (replaces Firestore announcements/latest doc)
    `CREATE TABLE IF NOT EXISTS announcements (
      id TEXT PRIMARY KEY,
      title TEXT,
      description TEXT,
      fullContent TEXT,
      mediaUrl TEXT,
      mediaType TEXT DEFAULT 'image',
      type TEXT DEFAULT 'info',
      active BOOLEAN DEFAULT 1,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    );`,

    // 8. Event Analytics
    `CREATE TABLE IF NOT EXISTS event_analytics (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      user_uid TEXT,
      data TEXT,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    );`,

    // 9. AI Memories
    `CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      text TEXT NOT NULL,
      topic TEXT,
      emotion TEXT,
      status TEXT DEFAULT 'ACTIVE',
      replacedBy TEXT,
      reason TEXT,
      archivedAt DATETIME,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    );`
  ];

  // Safe column additions for existing tables (won't fail if column already exists)
  const alterStatements = [
    { table: 'users', column: 'tourCompleted', type: 'BOOLEAN DEFAULT 0' },
    { table: 'users', column: 'warnings', type: 'INTEGER DEFAULT 0' },
    { table: 'users', column: 'lastWarningAt', type: 'DATETIME' },
    { table: 'users', column: 'blocked', type: 'BOOLEAN DEFAULT 0' },
    { table: 'users', column: 'seenPersonalities', type: 'TEXT' },
    { table: 'users', column: 'location', type: 'TEXT' },
    { table: 'users', column: 'device', type: 'TEXT' },
    { table: 'users', column: 'memory', type: 'TEXT' },
    { table: 'users', column: 'semanticMemory', type: 'TEXT' },
    { table: 'users', column: 'lastReflection', type: 'DATETIME' },
    { table: 'sessions', column: 'blocked', type: 'BOOLEAN DEFAULT 0' },
    { table: 'sessions', column: 'blockedBy', type: 'TEXT' },
    { table: 'sessions', column: 'blockReason', type: 'TEXT' },
    { table: 'sessions', column: 'wasBlocked', type: 'BOOLEAN DEFAULT 0' },
    { table: 'sessions', column: 'lastBlockedAt', type: 'DATETIME' },
    { table: 'sessions', column: 'lastSubtleNote', type: 'TEXT' },
    { table: 'sessions', column: 'warnings', type: 'INTEGER DEFAULT 0' },
    { table: 'vector_chunks', column: 'fileId', type: 'TEXT' },
    { table: 'personalities', column: 'description', type: 'TEXT' },
    { table: 'personalities', column: 'videoUrl', type: 'TEXT' },
    { table: 'announcements', column: 'fullContent', type: 'TEXT' },
    { table: 'announcements', column: 'mediaUrl', type: 'TEXT' },
    { table: 'announcements', column: 'mediaType', type: 'TEXT DEFAULT \'image\'' },
  ];

  try {
    for (const sql of schemaStatements) {
      try {
        await executeSql(sql);
      } catch (err) {
        console.warn('⚠️ Schema init error for statement:', err.message);
      }
    }

    // Safe ALTER TABLE additions
    for (const { table, column, type } of alterStatements) {
      try {
        await executeSql(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      } catch (e) {
        // Column already exists — safe to ignore
      }
    }

    console.log('✅ Turso Schema verified & synchronized.');
  } catch (error) {
    console.error('❌ Failed to initialize Turso schema:', error.message);
  }
}

module.exports = { initializeTursoSchema };
