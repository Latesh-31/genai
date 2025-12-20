require('dotenv').config();

const path = require('path');
const bcrypt = require('bcrypt');
const express = require('express');
const expressLayouts = require('express-ejs-layouts');
const helmet = require('helmet');
const session = require('express-session');

// 1. IMPORT AI CONTROLLER (New)
const { generateLesson } = require('./controllers/aiController'); 

// Database Configuration
const { initializeDB, query } = require('./config/database');
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
  await query('SELECT 1');
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

  const existing = await query('SELECT id FROM users WHERE email = ? LIMIT 1', [email]);
  if (existing.length) {
    return res.redirect('/register?error=' + encodeURIComponent('Email already exists.'));
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const result = await query('INSERT INTO users (name, email, password) VALUES (?, ?, ?)', [
    name, email, passwordHash
  ]);

  req.session.user = { id: result.insertId, name, email };
  res.redirect('/dashboard?message=' + encodeURIComponent('Welcome to AdaptLearn AI!'));
}));

app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('login', { title: 'Login' });
});

app.post('/login', asyncHandler(async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';

  const users = await query('SELECT id, name, email, password FROM users WHERE email = ? LIMIT 1', [email]);
  const user = users[0];

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

// ---------------------------------------------------------
// COURSE ROUTE (Load Page)
// ---------------------------------------------------------
app.get('/course/:id', requireAuth, asyncHandler(async (req, res) => {
  const courseId = req.params.id;
  
  const courses = await query('SELECT * FROM courses WHERE id = ?', [courseId]);
  const course = courses[0];

  if (!course) {
    return res.status(404).render('error', { 
      title: 'Not Found', statusCode: 404, errorMessage: 'Course not found.' 
    });
  }

  // Parse Syllabus
  try {
    course.syllabus = JSON.parse(course.syllabus_json || '[]');
  } catch (e) {
    course.syllabus = [];
  }

  // Default Lesson (Intro)
  const firstModuleTitle = course.syllabus[0]?.title || "Introduction";
  const defaultLesson = {
    title: firstModuleTitle,
    cards: [
      { 
        type: "text", 
        content: `## Welcome to ${course.topic} \n\nThis course is personalized for your **${course.level || 'Beginner'}** level.\n\nClick **Next** to start module 1!` 
      },
      {
        type: "chart",
        content: "graph TD; A[Start] --> B(Module 1); B --> C{Quiz}; C -- Pass --> D[Next];"
      }
    ]
  };

  res.render('course', { 
    title: course.topic,
    course: course,
    lesson: defaultLesson 
  });
}));

// ---------------------------------------------------------
// NEW API: GENERATE LESSON (Called by Frontend fetch)
// ---------------------------------------------------------
app.post('/api/generate-lesson', requireAuth, asyncHandler(async (req, res) => {
    const { courseId, moduleIndex } = req.body;

    // 1. Get Course
    const courses = await query('SELECT * FROM courses WHERE id = ?', [courseId]);
    const course = courses[0];

    if (!course) return res.status(404).json({ error: 'Course not found' });

    // 2. Identify Topic
    const syllabus = JSON.parse(course.syllabus_json || '[]');
    const module = syllabus[moduleIndex];

    if (!module) return res.status(404).json({ error: 'Module not found' });

    // 3. Ask AI
    const topicPrompt = `${module.title}: ${module.topics ? module.topics.join(', ') : ''}`;
    
    try {
        // Use the imported controller function
        const lessonData = await generateLesson(topicPrompt, course.level || 'Beginner');
        res.json(lessonData);
    } catch (error) {
        console.error("AI Generation Error:", error);
        res.status(500).json({ error: "Failed to generate lesson content." });
    }
}));
// ---------------------------------------------------------

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
  await initializeDB();
  app.listen(port, () => {
    console.log(`AdaptLearn AI running on http://localhost:${port}`);
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});