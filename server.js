require('dotenv').config();

const path = require('path');
const bcrypt = require('bcrypt');
const express = require('express');
const expressLayouts = require('express-ejs-layouts');
const helmet = require('helmet');
const session = require('express-session');

// 1. IMPORT AI CONTROLLER (New)
const { generateLesson } = require('./controllers/aiController'); 

// Firebase Configuration
const { db, admin } = require('./config/firebase');
const appRoutes = require('./routes/appRoutes');

const app = express();

// Middleware Setup
app.use(
  helmet({
    contentSecurityPolicy: false // Disabled for inline scripts (Mermaid/Tailwind)
  })
);

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.use(
  session({
    name: 'adaptlearn.sid',
    secret: process.env.SESSION_SECRET || 'dev-only-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 1000 * 60 * 60 * 24 * 7 // 1 Week
    }
  })
);

// View Engine Setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layout');
app.use(express.static(path.join(__dirname, 'public')));

// Global Variables
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.message = typeof req.query.message === 'string' ? req.query.message : null;
  res.locals.error = typeof req.query.error === 'string' ? req.query.error : null;
  next();
});

// Helper Functions
function asyncHandler(fn) {
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.redirect('/login?error=' + encodeURIComponent('Please log in to continue.'));
  }
  return next();
}

// --- ROUTES ---

// Landing / Health
app.get('/', (req, res) => {
  res.redirect(req.session.user ? '/dashboard' : '/login');
});

app.get('/health', asyncHandler(async (req, res) => {
  // Simple health check - Firebase connection is established at startup
  res.json({ ok: true });
}));

// Authentication Routes
app.get('/register', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('register', { title: 'Create account' });
});

app.post('/register', asyncHandler(async (req, res) => {
  const name = (req.body.name || '').trim();
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';

  if (!name || !email || !password) {
    return res.redirect('/register?error=' + encodeURIComponent('All fields are required.'));
  }
  if (password.length < 8) {
    return res.redirect('/register?error=' + encodeURIComponent('Password must be at least 8 characters.'));
  }

  const existingUsers = await db.collection('users').where('email', '==', email).limit(1).get();
  if (!existingUsers.empty) {
    return res.redirect('/register?error=' + encodeURIComponent('Email already exists.'));
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const userRef = await db.collection('users').add({
    name,
    email,
    password: passwordHash,
    total_xp: 0,
    streak_days: 0,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });

  req.session.user = { id: userRef.id, name, email };
  res.redirect('/dashboard?message=' + encodeURIComponent('Welcome to AdaptLearn AI!'));
}));

app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('login', { title: 'Login' });
});

app.post('/login', asyncHandler(async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';

  const usersSnapshot = await db.collection('users').where('email', '==', email).limit(1).get();
  if (usersSnapshot.empty) {
    return res.redirect('/login?error=' + encodeURIComponent('Invalid email or password.'));
  }
  
  const userDoc = usersSnapshot.docs[0];
  const user = { id: userDoc.id, ...userDoc.data() };

  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.redirect('/login?error=' + encodeURIComponent('Invalid email or password.'));
  }

  req.session.user = { id: user.id, name: user.name, email: user.email };
  res.redirect('/dashboard');
}));

app.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login?message=' + encodeURIComponent('Logged out successfully.'));
  });
});

app.use('/', appRoutes);

// Error Handling
app.use((req, res) => {
  res.status(404).render('error', {
    title: 'Not Found', statusCode: 404, errorMessage: 'Page not found.'
  });
});

app.use((err, req, res, next) => {
  const status = err.statusCode || 500;
  const message = err.message || 'Something went wrong.';
  if (process.env.NODE_ENV !== 'production') console.error(err);
  res.status(status).render('error', {
    title: 'Error', statusCode: status, errorMessage: message
  });
});

// Start Server
const port = Number(process.env.PORT || 3000);

async function start() {
  // Firebase is already initialized when module is loaded
  app.listen(port, () => {
    console.log(`AdaptLearn AI running on http://localhost:${port}`);
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});