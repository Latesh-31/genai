require('dotenv').config();

const path = require('path');

const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const db = open({
  filename: path.join(__dirname, '..', 'adaptlearn.db'),
  driver: sqlite3.Database
});

async function initializeDB() {
  const database = await db;

  await database.exec('PRAGMA foreign_keys = ON;');

  const tables = [
    {
      name: 'users',
      sql: 'CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, email TEXT UNIQUE, password TEXT)'
    },
    {
      name: 'courses',
      sql: 'CREATE TABLE IF NOT EXISTS courses (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, topic TEXT, syllabus_json TEXT, progress INTEGER)'
    },
    {
      name: 'assessments',
      sql: 'CREATE TABLE IF NOT EXISTS assessments (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, topic TEXT, score INTEGER, feedback_text TEXT)'
    }
  ];

  for (const table of tables) {
    const existing = await database.get(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      [table.name]
    );

    if (!existing) {
      await database.exec(table.sql);
    }
  }
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
