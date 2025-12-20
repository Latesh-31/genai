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
      'INSERT INTO courses (user_id, topic, syllabus_json, progress, level, completed_modules) VALUES (?, ?, ?, ?, ?, ?)',
      [req.session.user.id, subject, JSON.stringify(syllabus), 0, level, 0]
    );

    // Save assessment record as well
    await query(
      'INSERT INTO assessments (user_id, topic, score, feedback_text, analysis_json) VALUES (?, ?, ?, ?, ?)',
      [req.session.user.id, subject, grading.score, grading.feedback_text, JSON.stringify(grading.per_question)]
    );

    delete req.session.currentAssessment;
    
    // Redirect to report page instead of course
    res.redirect(`/report/${courseResult.insertId}`);
  } catch (err) {
    console.error(err);
    res.redirect('/dashboard?error=' + encodeURIComponent('Failed to process quiz results.'));
  }
}));

// GET /report/:id - First Impression Report
router.get('/report/:id', requireAuth, asyncHandler(async (req, res) => {
  const courseId = parseInt(req.params.id, 10);
  
  // Get the course and assessment data
  const courseRows = await query('SELECT * FROM courses WHERE id = ? AND user_id = ?', [courseId, req.session.user.id]);
  if (!courseRows.length) {
    return res.redirect('/dashboard?error=' + encodeURIComponent('Course not found.'));
  }
  
  const assessmentRows = await query('SELECT * FROM assessments WHERE user_id = ? AND topic = ? ORDER BY id DESC LIMIT 1', [
    req.session.user.id, 
    courseRows[0].topic
  ]);
  
  if (!assessmentRows.length) {
    return res.redirect('/dashboard?error=' + encodeURIComponent('Assessment not found.'));
  }

  const course = courseRows[0];
  const assessment = assessmentRows[0];
  
  let syllabus = [];
  try {
    syllabus = JSON.parse(course.syllabus_json);
  } catch (e) {
    syllabus = [];
  }
  
  let analysis = [];
  try {
    analysis = assessment.analysis_json ? JSON.parse(assessment.analysis_json) : [];
  } catch (e) {
    analysis = [];
  }

  // Determine level badge
  const score = assessment.score || 0;
  const levelBadge = score < 3 ? 'Apprentice' : (score < 5 ? 'Adept' : 'Master');

  res.render('report', {
    title: `${course.topic} - Assessment Report`,
    course,
    assessment,
    syllabus,
    analysis,
    levelBadge,
    score
  });
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
    return res.status(404).json({ error: 'Course not found' });
  }

  const course = rows[0];
  const syllabus = JSON.parse(course.syllabus_json);
  const modIdx = parseInt(moduleIndex, 10);
  const topIdx = parseInt(topicIndex, 10);

  if (!syllabus[modIdx] || !syllabus[modIdx].topics[topIdx]) {
    return res.status(404).json({ error: 'Topic not found' });
  }

  const topicName = syllabus[modIdx].topics[topIdx];
  const lessonContent = await aiController.generateLesson(topicName, course.level);

  res.json(lessonContent);
}));

// POST /course/:id/complete - Track lesson completion and award XP
router.post('/course/:id/complete', requireAuth, asyncHandler(async (req, res) => {
  const courseId = parseInt(req.params.id, 10);
  const userId = req.session.user.id;
  const { moduleIndex, topicIndex, xpEarned = 100 } = req.body;

  // Verify course ownership
  const courseRows = await query('SELECT * FROM courses WHERE id = ? AND user_id = ?', [courseId, userId]);
  if (!courseRows.length) {
    return res.status(404).json({ error: 'Course not found' });
  }

  const course = courseRows[0];
  const syllabus = JSON.parse(course.syllabus_json);

  if (!syllabus[moduleIndex] || !syllabus[moduleIndex].topics[topicIndex]) {
    return res.status(404).json({ error: 'Topic not found' });
  }

  // Check if lesson was already completed
  const completedRows = await query(
    'SELECT id FROM lesson_completions WHERE user_id = ? AND course_id = ? AND module_index = ? AND topic_index = ?',
    [userId, courseId, moduleIndex, topicIndex]
  );

  if (!completedRows.length) {
    // Insert lesson completion
    await query(
      'INSERT INTO lesson_completions (user_id, course_id, module_index, topic_index, xp_earned) VALUES (?, ?, ?, ?, ?)',
      [userId, courseId, moduleIndex, topicIndex, xpEarned]
    );

    // Update user's total XP and streak
    await query('UPDATE users SET total_xp = total_xp + ?, last_lesson_date = CURRENT_DATE WHERE id = ?', [xpEarned, userId]);

    // Update streak (simplified logic - would need more sophisticated date checking in production)
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    
    const yesterdayStr = yesterday.toISOString().split('T')[0];
    const userRows = await query('SELECT last_lesson_date FROM users WHERE id = ?', [userId]);
    
    if (userRows[0].last_lesson_date === yesterdayStr) {
      await query('UPDATE users SET streak_days = streak_days + 1 WHERE id = ?', [userId]);
    } else if (!userRows[0].last_lesson_date || userRows[0].last_lesson_date < yesterdayStr) {
      await query('UPDATE users SET streak_days = 1 WHERE id = ?', [userId]);
    }
  }

  res.json({ success: true, xpEarned  });
}));

// GET /course/:id/module/:moduleIndex/exit-quiz - Generate module exit quiz
router.get('/course/:id/module/:moduleIndex/exit-quiz', requireAuth, asyncHandler(async (req, res) => {
  const courseId = parseInt(req.params.id, 10);
  const moduleIndex = parseInt(req.params.moduleIndex, 10);
  
  // Verify course ownership
  const courseRows = await query('SELECT * FROM courses WHERE id = ? AND user_id = ?', [courseId, req.session.user.id]);
  if (!courseRows.length) {
    return res.status(404).json({ error: 'Course not found' });
  }
  
  const course = courseRows[0];
  const syllabus = JSON.parse(course.syllabus_json);
  
  if (!syllabus[moduleIndex]) {
    return res.status(404).json({ error: 'Module not found' });
  }
  
  const module = syllabus[moduleIndex];
  
  try {
    const quiz = await aiController.generateModuleExitQuiz(module.title, module.topics, course.level);
    res.json({ quiz, moduleTitle: module.title });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to generate exit quiz' });
  }
}));

// POST /course/:id/module/:moduleIndex/verify - Verify module completion
router.post('/course/:id/module/:moduleIndex/verify', requireAuth, asyncHandler(async (req, res) => {
  const courseId = parseInt(req.params.id, 10);
  const moduleIndex = parseInt(req.params.moduleIndex, 10);
  const userId = req.session.user.id;
  
  // Verify course ownership
  const courseRows = await query('SELECT * FROM courses WHERE id = ? AND user_id = ?', [courseId, userId]);
  if (!courseRows.length) {
    return res.status(404).json({ error: 'Course not found' });
  }
  
  const course = courseRows[0];
  const syllabus = JSON.parse(course.syllabus_json);
  
  if (!syllabus[moduleIndex]) {
    return res.status(404).json({ error: 'Module not found' });
  }
  
  const module = syllabus[moduleIndex];
  const userAnswers = req.body.answers || [];
  
  // Generate the quiz to grade it
  const quiz = await aiController.generateModuleExitQuiz(module.title, module.topics, course.level);
  
  // Grade the quiz
  const gradingResult = await aiController.gradeQuiz(module.title, quiz, userAnswers);
  
  const passed = gradingResult.score >= 2; // 66% passing grade (2/3 questions)
  
  if (passed && moduleIndex === course.completed_modules) {
    // Update completed modules
    await query('UPDATE courses SET completed_modules = ? WHERE id = ?', [moduleIndex + 1, courseId]);
  }
  
  res.json({
    passed,
    score: gradingResult.score,
    feedback: gradingResult.feedback_text,
    newCompletedModules: passed ? moduleIndex + 1 : course.completed_modules
  });
}));

// POST /course/:id/tutor
router.post('/course/:id/tutor', requireAuth, asyncHandler(async (req, res) => {
  const courseId = parseInt(req.params.id, 10);
  const rows = await query('SELECT * FROM courses WHERE id = ? AND user_id = ?', [courseId, req.session.user.id]);

  if (!rows.length) {
    return res.status(404).json({ error: 'Course not found' });
  }

  const question = (req.body.question || '').trim();
  if (!question) {
    return res.status(400).json({ error: 'Question is required' });
  }

  const lessonTopic = typeof req.body.lessonTopic === 'string' ? req.body.lessonTopic.trim() : '';
  const lessonText = typeof req.body.lessonText === 'string' ? req.body.lessonText : '';

  const course = rows[0];

  const answer = await aiController.generateTutorResponse({
    question,
    courseTopic: course.topic,
    userLevel: course.level,
    lessonTopic,
    lessonText
  });

  res.json({ answer });
}));

module.exports = router;
