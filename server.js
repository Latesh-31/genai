require('dotenv').config();

const path = require('path');

const bcrypt = require('bcrypt');
const express = require('express');
const expressLayouts = require('express-ejs-layouts');
const helmet = require('helmet');
const session = require('express-session');

const { initializeDB, query } = require('./config/database');
const appRoutes = require('./routes/appRoutes');

const app = express();

app.use(
  helmet({
    contentSecurityPolicy: false
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
      maxAge: 1000 * 60 * 60 * 24 * 7
    }
  })
);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layout');

app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.message = typeof req.query.message === 'string' ? req.query.message : null;
  res.locals.error = typeof req.query.error === 'string' ? req.query.error : null;
  next();
});

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

app.get('/', (req, res) => {
  res.redirect(req.session.user ? '/dashboard' : '/login');
});

app.get('/health', asyncHandler(async (req, res) => {
  await query('SELECT 1');
  res.json({ ok: true });
}));

app.get('/register', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('register', { title: 'Create account' });
});

app.post('/register', asyncHandler(async (req, res) => {
  const name = (req.body.name || '').trim();
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';

  if (!name || !email || !password) {
    return res.redirect('/register?error=' + encodeURIComponent('Name, email, and password are required.'));
  }
  if (password.length < 8) {
    return res.redirect('/register?error=' + encodeURIComponent('Password must be at least 8 characters.'));
  }

  const existing = await query('SELECT id FROM users WHERE email = ? LIMIT 1', [email]);
  if (existing.length) {
    return res.redirect('/register?error=' + encodeURIComponent('An account with that email already exists.'));
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const result = await query('INSERT INTO users (name, email, password) VALUES (?, ?, ?)', [
    name,
    email,
    passwordHash
  ]);

  req.session.user = { id: result.insertId, name, email };
  res.redirect('/dashboard?message=' + encodeURIComponent('Account created. Welcome to AdaptLearn AI.'));
}));

app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('login', { title: 'Login' });
});

app.post('/login', asyncHandler(async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';

  if (!email || !password) {
    return res.redirect('/login?error=' + encodeURIComponent('Email and password are required.'));
  }

  const users = await query('SELECT id, name, email, password FROM users WHERE email = ? LIMIT 1', [email]);
  const user = users[0];

  if (!user) {
    return res.redirect('/login?error=' + encodeURIComponent('Invalid email or password.'));
  }

  const ok = await bcrypt.compare(password, user.password);
  if (!ok) {
    return res.redirect('/login?error=' + encodeURIComponent('Invalid email or password.'));
  }

  req.session.user = { id: user.id, name: user.name, email: user.email };
  res.redirect('/dashboard');
}));

app.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login?message=' + encodeURIComponent('Logged out.'));
  });
});

app.use('/', appRoutes);

app.use((req, res) => {
  res.status(404).render('error', {
    title: 'Not Found',
    statusCode: 404,
    errorMessage: 'Page not found.'
  });
});

app.use((err, req, res, next) => {
  const status = err.statusCode || 500;
  const message = err.message || 'Something went wrong.';

  if (process.env.NODE_ENV !== 'production') {
    console.error(err);
  }

  res.status(status).render('error', {
    title: 'Error',
    statusCode: status,
    errorMessage: message
  });
});

const port = Number(process.env.PORT || 3000);

async function start() {
  await initializeDB();

  app.listen(port, () => {
    console.log(`AdaptLearn AI running on http://localhost:${port}`);
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
