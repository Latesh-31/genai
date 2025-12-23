require('dotenv').config();
const admin = require('firebase-admin');
const serviceAccount = require('../serviceAccountKey.json');

// Initialize Firebase Admin SDK
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: serviceAccount.project_id
});

const db = admin.firestore();

// Configure Firestore settings
db.settings({
  timestampsInSnapshots: true,
  ignoreUndefinedProperties: true
});

module.exports = { db, admin };