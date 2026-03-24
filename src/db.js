require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host: 'localhost',
  port: 5432,
  database: 'vinted_hunter',
  user: 'postgres',
  password: process.env.DB_PASSWORD,
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS search_profiles (
      id               SERIAL PRIMARY KEY,
      product_name     TEXT NOT NULL,
      keywords         TEXT[] NOT NULL,
      price_min        INTEGER NOT NULL,
      price_max        INTEGER NOT NULL,
      negative_keywords TEXT[] DEFAULT '{}',
      created_at       TIMESTAMPTZ DEFAULT NOW(),
      updated_at       TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS seen_items (
      id          TEXT PRIMARY KEY,
      profile_id  INTEGER REFERENCES search_profiles(id),
      title       TEXT,
      price       NUMERIC,
      notified_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS filter_feedback (
      id          SERIAL PRIMARY KEY,
      profile_id  INTEGER REFERENCES search_profiles(id),
      item_id     TEXT,
      item_title  TEXT,
      feedback    TEXT CHECK (feedback IN ('good', 'false_positive')),
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('[DB] Tabelle inizializzate.');
}

async function saveProfile({ productName, keywords, priceMin, priceMax, negativeKeywords = [] }) {
  const res = await pool.query(
    `INSERT INTO search_profiles (product_name, keywords, price_min, price_max, negative_keywords)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [productName, keywords, priceMin, priceMax, negativeKeywords]
  );
  return res.rows[0].id;
}

async function getProfile(nameOrId) {
  const byId = typeof nameOrId === 'number' || /^\d+$/.test(String(nameOrId));
  const res = byId
    ? await pool.query('SELECT * FROM search_profiles WHERE id = $1', [nameOrId])
    : await pool.query('SELECT * FROM search_profiles WHERE LOWER(product_name) = LOWER($1) ORDER BY created_at DESC LIMIT 1', [nameOrId]);
  return res.rows[0] || null;
}

async function isSeen(itemId) {
  const res = await pool.query('SELECT 1 FROM seen_items WHERE id = $1', [itemId]);
  return res.rowCount > 0;
}

async function markSeen({ id, profileId, title, price }) {
  await pool.query(
    `INSERT INTO seen_items (id, profile_id, title, price)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO NOTHING`,
    [id, profileId, title, price]
  );
}

async function saveFeedback({ profileId, itemId, itemTitle, feedback }) {
  await pool.query(
    `INSERT INTO filter_feedback (profile_id, item_id, item_title, feedback)
     VALUES ($1, $2, $3, $4)`,
    [profileId, itemId, itemTitle, feedback]
  );
}

async function getFeedbackStats(profileId) {
  const res = await pool.query(
    `SELECT feedback, COUNT(*) AS count
     FROM filter_feedback
     WHERE profile_id = $1
     GROUP BY feedback`,
    [profileId]
  );
  const stats = { good: 0, false_positive: 0 };
  for (const row of res.rows) {
    stats[row.feedback] = parseInt(row.count, 10);
  }
  return stats;
}

async function getFeedbackTitles(profileId) {
  const res = await pool.query(
    `SELECT item_title, feedback FROM filter_feedback WHERE profile_id = $1`,
    [profileId]
  );
  return res.rows; // [{ item_title, feedback }]
}

async function addNegativeKeywords(profileId, words) {
  await pool.query(
    `UPDATE search_profiles
     SET negative_keywords = (
       SELECT ARRAY(SELECT DISTINCT unnest(negative_keywords || $2::text[]))
     ),
     updated_at = NOW()
     WHERE id = $1`,
    [profileId, words]
  );
}

module.exports = { initDB, saveProfile, getProfile, isSeen, markSeen, saveFeedback, getFeedbackStats, getFeedbackTitles, addNegativeKeywords };
