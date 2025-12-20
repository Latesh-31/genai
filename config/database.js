require('dotenv').config();
const path = require('path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

// Open the database connection
const db = open({
  filename: path.join(__dirname, '..', 'adaptlearn.db'),
  driver: sqlite3.Database
});

async function initializeDB() {
  const database = await db;

  // Enforce foreign key constraints
  await database.exec('PRAGMA foreign_keys = ON;');

  // Define tables schema
  const tables = [
    {
      name: 'users',
      sql: `CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT, 
        name TEXT, 
        email TEXT UNIQUE, 
        password TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`
    },
    {
      name: 'courses',
      sql: `CREATE TABLE IF NOT EXISTS courses (
        id INTEGER PRIMARY KEY AUTOINCREMENT, 
        user_id INTEGER, 
        topic TEXT, 
        level TEXT,
        syllabus_json TEXT, 
        progress INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`
    },
    {
      name: 'assessments',
      sql: `CREATE TABLE IF NOT EXISTS assessments (
        id INTEGER PRIMARY KEY AUTOINCREMENT, 
        user_id INTEGER, 
        topic TEXT, 
        score INTEGER, 
        feedback_text TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`
    }
  ];

  // Loop through tables and create them if they don't exist
  for (const table of tables) {
    const existing = await database.get(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      [table.name]
    );

    if (!existing) {
      console.log(`Creating table: ${table.name}`);
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