require('dotenv').config();
const path = require('path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const db = open({
  filename: path.join(__dirname, '..', 'adaptlearn.db'),
  driver: sqlite3.Database
});

async function ensureColumns(database, tableName, columns) {
  const info = await database.all(`PRAGMA table_info(${tableName});`);
  const existing = new Set(info.map((c) => c.name));

  for (const col of columns) {
    if (existing.has(col.name)) continue;

    const defaultSql = col.defaultSql ? ` DEFAULT ${col.defaultSql}` : '';
    await database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${col.name} ${col.type}${defaultSql};`);
  }
}

async function initializeDB() {
  const database = await db;

  await database.exec('PRAGMA foreign_keys = ON;');

  await database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      total_xp INTEGER NOT NULL DEFAULT 0,
      streak_days INTEGER NOT NULL DEFAULT 0,
      last_lesson_date TEXT DEFAULT NULL,
      badges_json TEXT DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await database.exec(`
    CREATE TABLE IF NOT EXISTS courses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      topic TEXT NOT NULL,
      level TEXT,
      syllabus_json TEXT NOT NULL,
      progress INTEGER NOT NULL DEFAULT 0,
      completed_modules INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  await database.exec(`
    CREATE TABLE IF NOT EXISTS assessments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      topic TEXT NOT NULL,
      score INTEGER NOT NULL,
      feedback_text TEXT,
      analysis_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  await database.exec(`
    CREATE TABLE IF NOT EXISTS lesson_completions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      course_id INTEGER NOT NULL,
      module_index INTEGER NOT NULL,
      topic_index INTEGER NOT NULL,
      xp_earned INTEGER NOT NULL DEFAULT 100,
      completed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (user_id, course_id, module_index, topic_index),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE
    );
  `);

  await ensureColumns(database, 'users', [
    { name: 'total_xp', type: 'INTEGER', defaultSql: '0' },
    { name: 'streak_days', type: 'INTEGER', defaultSql: '0' },
    { name: 'last_lesson_date', type: 'TEXT', defaultSql: 'NULL' },
    { name: 'badges_json', type: 'TEXT', defaultSql: 'NULL' }
  ]);

  await ensureColumns(database, 'courses', [
    { name: 'level', type: 'TEXT', defaultSql: 'NULL' },
    { name: 'completed_modules', type: 'INTEGER', defaultSql: '0' }
  ]);

  await ensureColumns(database, 'assessments', [
    { name: 'analysis_json', type: 'TEXT', defaultSql: 'NULL' }
  ]);
}

async function query(sql, params = []) {
  const database = await db;
  const statement = sql.trim().toLowerCase();

  if (statement.startsWith('select') || statement.startsWith('pragma') || statement.startsWith('with')) {
    return database.all(sql, params);
  }

  const result = await database.run(sql, params);
  return {
    insertId: result.lastID,
    affectedRows: result.changes
  };
}

module.exports = {
  db,
  query,
  initializeDB
};
