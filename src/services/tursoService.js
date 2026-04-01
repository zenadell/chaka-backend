const { createClient } = require('@libsql/client');

// Keep connection URL and Token logic flexible for local testing vs production
const dbUrl = process.env.TURSO_DATABASE_URL || 'file:local.db';
const dbAuthToken = process.env.TURSO_AUTH_TOKEN;

const turso = createClient({
  url: dbUrl,
  authToken: dbAuthToken,
});

/**
 * Execute a single SQL query
 */
async function executeSql(sql, args = []) {
  try {
    const result = await turso.execute({ sql, args });
    return result;
  } catch (error) {
    console.error('Turso DB Error (executeSql):', error);
    throw error;
  }
}

/**
 * Execute multiple SQL queries in a transaction/batch
 */
async function batchSql(statements) {
   try {
    const result = await turso.batch(statements);
    return result;
  } catch (error) {
    console.error('Turso DB Error (batchSql):', error);
    throw error;
  }
}

module.exports = {
  turso,
  executeSql,
  batchSql
};
