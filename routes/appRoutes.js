const express = require('express');
const router = express.Router();
const aiController = require('../controllers/aiController');
const { query } = require('../config/database');

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

// GET /dashboard
router.get('/dashboard', requireAuth, asyncHandler(async (req, res) => {
  const subjects = [
    { name: 'Python', icon: '🐍' },
    { name: 'React', icon: '⚛️' },
    { name: 'History', icon: '📜' },
    { name: 'Physics', icon: '🔭' },
    { name: 'JavaScript', icon: '💻' },
    { name: 'SQL', icon: '🗄️' },
    { name: 'Machine Learning', icon: '🤖' },
    { name: 'System Design', icon: '🏗️' }
  ];

  const courses = await query(
    'SELECT id, topic, progress, level, created_at FROM courses WHERE user_id = ? ORDER BY id DESC',
    [req.session.user.id]
  );

  res.render('dashboard', {
    title: 'Dashboard',
    subjects,
    courses,
    user: req.session.user
  });
}));

// GET /quiz/:subject
router.get('/quiz/:subject', requireAuth, asyncHandler(async (req, res) => {
  const subject = req.params.subject;
  
  let quiz;
  try {
    quiz = await aiController.generateQuiz(subject);
  } catch (err) {
    return res.redirect('/dashboard?error=' + encodeURIComponent(err.message || 'Failed to generate quiz.'));
  }

  req.session.currentAssessment = {
    subject,
    quiz,
    startedAt: Date.now()
  };

  res.render('quiz', {
    title: `Assessment: ${subject}`,
    subject,
    quiz
  });
}));

// POST /quiz/submit
router.post('/quiz/submit', requireAuth, asyncHandler(async (req, res) => {
  const current = req.session.currentAssessment;
  if (!current || !current.quiz || !current.subject) {
    return res.redirect('/dashboard?error=' + encodeURIComponent('No active assessment found.'));
  }

  const { subject, quiz } = current;
  const userAnswers = quiz.map((_, idx) => {
    const val = req.body[`q${idx}`];
    return val ? parseInt(val, 10) : -1;
  });

  try {
    const result = await aiController.evaluateAndCreateSyllabus(subject, userAnswers, quiz);
    const { syllabus, level, grading } = result;

    const courseResult = await query(
      'INSERT INTO courses (user_id, topic, syllabus_json, progress, level) VALUES (?, ?, ?, ?, ?)',
      [req.session.user.id, subject, JSON.stringify(syllabus), 0, level]
    );

    // Save assessment record as well
    await query(
      'INSERT INTO assessments (user_id, topic, score, feedback_text) VALUES (?, ?, ?, ?)',
      [req.session.user.id, subject, grading.score, grading.feedback_text]
    );

    delete req.session.currentAssessment;
    res.redirect(`/course/${courseResult.insertId}`);
  } catch (err) {
    console.error(err);
    res.redirect('/dashboard?error=' + encodeURIComponent('Failed to process quiz results.'));
  }
}));

// GET /course/:id
router.get('/course/:id', requireAuth, asyncHandler(async (req, res) => {
  const courseId = parseInt(req.params.id, 10);
  const rows = await query('SELECT * FROM courses WHERE id = ? AND user_id = ?', [courseId, req.session.user.id]);
  
  if (!rows.length) {
    return res.redirect('/dashboard?error=' + encodeURIComponent('Course not found.'));
  }

  const course = rows[0];
  let syllabus = [];
  try {
    syllabus = JSON.parse(course.syllabus_json);
  } catch (e) {
    syllabus = [];
  }

  res.render('course', {
    title: course.topic,
    course,
    syllabus
  });
}));

// GET /course/:id/lesson/:moduleIndex/:topicIndex
router.get('/course/:id/lesson/:moduleIndex/:topicIndex', requireAuth, asyncHandler(async (req, res) => {
  const { id, moduleIndex, topicIndex } = req.params;
  
  const rows = await query('SELECT * FROM courses WHERE id = ? AND user_id = ?', [id, req.session.user.id]);
  if (!rows.length) {
    return res.status(404).send('Course not found');
  }

  const course = rows[0];
  const syllabus = JSON.parse(course.syllabus_json);
  const modIdx = parseInt(moduleIndex, 10);
  const topIdx = parseInt(topicIndex, 10);

  if (!syllabus[modIdx] || !syllabus[modIdx].topics[topIdx]) {
    return res.status(404).send('Topic not found');
  }

  const topicName = syllabus[modIdx].topics[topIdx];
  const lessonContent = await aiController.generateLesson(topicName, course.level);

  // Return partial HTML or JSON. 
  // Since the UI will likely use fetch to load this into the right pane:
  res.json({
    topic: topicName,
    content: lessonContent
  });
}));

module.exports = router;
