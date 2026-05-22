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
// Harmless errors we don't want to spam the log with
const HARMLESS_ERROR_PATTERNS = [
  /duplicate column name/i,
  /already exists/i,
];

function isHarmlessSchemaError(error) {
  const msg = (error && (error.message || error.cause?.message)) || '';
  return HARMLESS_ERROR_PATTERNS.some(p => p.test(msg));
}

async function executeSql(sql, args = []) {
  try {
    const result = await turso.execute({ sql, args });
    return result;
  } catch (error) {
    if (isHarmlessSchemaError(error)) {
      // Schema migration trying to add a column that already exists — silently swallow.
      // Still throw so callers (like initializeTursoSchema) can short-circuit; but no log spam.
    } else {
      console.error('Turso DB Error (executeSql):', error);
    }
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
