const express = require('express');
const router = express.Router();
const aiController = require('../controllers/aiController');
const appController = require('../controllers/appController');
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
router.get('/dashboard', requireAuth, asyncHandler(appController.getDashboard));

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
    const grading = await aiController.gradeQuiz(subject, quiz, userAnswers);

    const analysis = quiz.map((q, idx) => {
      const selectedIndex = Number.isInteger(userAnswers[idx]) ? userAnswers[idx] : -1;
      const correctIndex = Number.isInteger(q.correctIndex) ? q.correctIndex : 0;
      const selected = selectedIndex >= 0 ? q.options?.[selectedIndex] : null;
      const correctAnswer = q.options?.[correctIndex] || null;

      const pq = Array.isArray(grading.per_question)
        ? grading.per_question.find((p) => Number(p.index) === idx)
        : null;

      return {
        index: idx,
        question: q.question,
        selectedIndex,
        selected,
        correctIndex,
        correctAnswer,
        correct: selectedIndex === correctIndex,
        weak_topic: typeof q.weak_topic === 'string' ? q.weak_topic : null,
        note: pq && typeof pq.note === 'string' ? pq.note : ''
      };
    });

    const assessmentResult = await query(
      'INSERT INTO assessments (user_id, topic, score, feedback_text, analysis_json) VALUES (?, ?, ?, ?, ?)',
      [req.session.user.id, subject, grading.score, grading.feedback_text, JSON.stringify(analysis)]
    );

    req.session.currentAssessment = {
      ...current,
      userAnswers,
      grading,
      assessmentId: assessmentResult.insertId
    };

    const scoreOutOf100 = Math.round((grading.score / 5) * 100);
    const levelBadge = scoreOutOf100 < 60 ? 'Apprentice' : 'Adept';

    res.render('report', {
      title: `Report: ${subject}`,
      subject,
      grading,
      analysis,
      scoreOutOf100,
      levelBadge,
      assessmentId: assessmentResult.insertId
    });
  } catch (err) {
    console.error(err);
    res.redirect('/dashboard?error=' + encodeURIComponent(err.message || 'Failed to process quiz results.'));
  }
}));

// POST /assessment/:id/generate-map
router.post('/assessment/:id/generate-map', requireAuth, asyncHandler(appController.generateMapFromAssessment));

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
  let syllabus = [];
  try {
    syllabus = JSON.parse(course.syllabus_json);
  } catch (_) {
    syllabus = [];
  }

  const modIdx = parseInt(moduleIndex, 10);
  const topIdx = parseInt(topicIndex, 10);

  const unlockedThroughModule = Number.isInteger(course.completed_modules) ? course.completed_modules : 0;
  if (modIdx > unlockedThroughModule) {
    return res.status(403).json({ error: 'This module is locked. Pass the exit quiz to unlock it.' });
  }

  if (!syllabus[modIdx] || !syllabus[modIdx].topics || !syllabus[modIdx].topics[topIdx]) {
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
  let syllabus = [];
  try {
    syllabus = JSON.parse(course.syllabus_json);
  } catch (_) {
    syllabus = [];
  }

  if (!syllabus[moduleIndex] || !syllabus[moduleIndex].topics || !syllabus[moduleIndex].topics[topicIndex]) {
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

    // Update user's total XP + streak
    const todayStr = new Date().toISOString().split('T')[0];
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];

    const userRows = await query('SELECT last_lesson_date, streak_days FROM users WHERE id = ? LIMIT 1', [userId]);
    const lastLessonDate = userRows[0]?.last_lesson_date || null;
    const currentStreak = Number(userRows[0]?.streak_days || 0);

    let nextStreak = currentStreak;
    if (lastLessonDate === todayStr) {
      nextStreak = currentStreak;
    } else if (lastLessonDate === yesterdayStr) {
      nextStreak = currentStreak + 1;
    } else {
      nextStreak = 1;
    }

    await query('UPDATE users SET total_xp = total_xp + ?, last_lesson_date = ?, streak_days = ? WHERE id = ?', [
      xpEarned,
      todayStr,
      nextStreak,
      userId
    ]);
  }

  res.json({ success: true, xpEarned  });
}));

// POST /course/:id/verify-module
router.post('/course/:id/verify-module', requireAuth, asyncHandler(appController.verifyModuleMastery));

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
