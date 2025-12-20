const aiController = require('./aiController');
const { query } = require('../config/database');

const DEFAULT_SUBJECTS = [
  { name: 'Python', icon: '🐍' },
  { name: 'React', icon: '⚛️' },
  { name: 'History', icon: '📜' },
  { name: 'Physics', icon: '🔭' },
  { name: 'JavaScript', icon: '💻' },
  { name: 'SQL', icon: '🗄️' },
  { name: 'Machine Learning', icon: '🤖' },
  { name: 'System Design', icon: '🏗️' }
];

function parseJsonSafe(value, fallback) {
  if (!value || typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

function getModulesCountFromSyllabusJson(syllabusJson) {
  const parsed = parseJsonSafe(syllabusJson, null);
  if (Array.isArray(parsed)) return parsed.length;
  return 6;
}

async function getDashboard(req, res) {
  const userId = req.session.user.id;

  const userRows = await query(
    'SELECT id, name, email, total_xp, streak_days, last_lesson_date FROM users WHERE id = ? LIMIT 1',
    [userId]
  );
  const user = userRows[0] || req.session.user;

  const courses = await query(
    'SELECT id, topic, progress, level, completed_modules, syllabus_json, created_at FROM courses WHERE user_id = ? ORDER BY id DESC',
    [userId]
  );

  const activeTopics = new Set(
    (courses || []).map((c) => (c.topic || '').trim().toLowerCase()).filter(Boolean)
  );

  const exploreSubjects = DEFAULT_SUBJECTS.filter(
    (s) => !activeTopics.has(s.name.trim().toLowerCase())
  );

  const hydratedCourses = (courses || []).map((course) => {
    const modulesTotal = getModulesCountFromSyllabusJson(course.syllabus_json);
    const completedModules = Number.isFinite(course.completed_modules) ? course.completed_modules : 0;
    const completed = completedModules >= modulesTotal || Number(course.progress || 0) >= 100;

    return {
      ...course,
      modulesTotal,
      completedModules,
      completed
    };
  });

  res.render('dashboard', {
    title: 'Dashboard',
    user,
    exploreSubjects,
    resumeCourses: hydratedCourses.filter((c) => !c.completed),
    completedCourses: hydratedCourses.filter((c) => c.completed)
  });
}

function buildFallbackExitQuiz(module) {
  const topics = Array.isArray(module?.topics) ? module.topics : [];
  const seed = topics.slice(0, 3);
  const promptTopic = seed[0] || module?.title || 'this module';

  return Array.from({ length: 3 }).map((_, idx) => {
    const focus = seed[idx] || promptTopic;

    return {
      question: `Quick check: which option best matches the key idea of "${focus}"?`,
      options: [
        `The core definition/concept of ${focus}`,
        `An unrelated idea that sounds similar`,
        `A common misconception about ${focus}`,
        `A detail that is true but not the main idea`
      ],
      correctIndex: 0,
      review_topic: focus,
      explanation: `If you missed this, re-read the section covering ${focus} and try to explain it in your own words.`
    };
  });
}

async function verifyModuleMastery(req, res) {
  const courseId = Number(req.params.id);
  const userId = req.session.user.id;

  const moduleIndex = Number(req.body.moduleIndex);
  if (!Number.isInteger(courseId) || !Number.isInteger(moduleIndex) || moduleIndex < 0) {
    return res.status(400).json({ error: 'Invalid courseId or moduleIndex' });
  }

  const rows = await query('SELECT * FROM courses WHERE id = ? AND user_id = ? LIMIT 1', [courseId, userId]);
  if (!rows.length) {
    return res.status(404).json({ error: 'Course not found' });
  }

  const course = rows[0];
  const syllabus = parseJsonSafe(course.syllabus_json, []);

  if (!Array.isArray(syllabus) || !syllabus[moduleIndex]) {
    return res.status(404).json({ error: 'Module not found' });
  }

  const completedModules = Number.isInteger(course.completed_modules) ? course.completed_modules : 0;

  if (moduleIndex < completedModules) {
    return res.json({
      passed: true,
      alreadyUnlocked: true,
      completed_modules: completedModules,
      progress: Number(course.progress || 0)
    });
  }

  if (moduleIndex !== completedModules) {
    return res.status(403).json({ error: 'This module is locked. Complete previous modules first.' });
  }

  const module = syllabus[moduleIndex];
  const exitQuiz = Array.isArray(module.exit_quiz) && module.exit_quiz.length
    ? module.exit_quiz
    : buildFallbackExitQuiz(module);

  const answers = Array.isArray(req.body.answers)
    ? req.body.answers.map((n) => Number(n))
    : [];

  const total = exitQuiz.length;
  const perQuestion = exitQuiz.map((q, idx) => {
    const submitted = Number.isInteger(answers[idx]) ? answers[idx] : -1;
    const correctIndex = Number.isInteger(q.correctIndex) ? q.correctIndex : 0;

    return {
      idx,
      submitted,
      correctIndex,
      correct: submitted === correctIndex,
      review_topic: typeof q.review_topic === 'string' && q.review_topic.trim() ? q.review_topic.trim() : null,
      explanation: typeof q.explanation === 'string' ? q.explanation : ''
    };
  });

  const correctCount = perQuestion.filter((p) => p.correct).length;
  const scorePct = total ? correctCount / total : 0;
  const passed = scorePct >= 2 / 3;

  if (!passed) {
    const misses = perQuestion.filter((p) => !p.correct);
    const reviewTopics = misses
      .map((m) => m.review_topic)
      .filter(Boolean)
      .slice(0, 3);

    const feedbackText = reviewTopics.length
      ? `Review the section on ${reviewTopics.join(', ')} and retry the lesson.`
      : 'Review the lesson and try again.';

    return res.json({
      passed: false,
      correct: correctCount,
      total,
      feedbackText,
      mistakes: misses.map((m) => ({
        index: m.idx,
        review_topic: m.review_topic,
        explanation: m.explanation
      }))
    });
  }

  const modulesTotal = Array.isArray(syllabus) ? syllabus.length : 6;
  const nextCompleted = Math.min(modulesTotal, completedModules + 1);
  const nextProgress = Math.round((nextCompleted / modulesTotal) * 100);

  await query('UPDATE courses SET completed_modules = ?, progress = ? WHERE id = ? AND user_id = ?', [
    nextCompleted,
    nextProgress,
    courseId,
    userId
  ]);

  return res.json({
    passed: true,
    correct: correctCount,
    total,
    completed_modules: nextCompleted,
    progress: nextProgress
  });
}

async function generateMapFromAssessment(req, res) {
  const assessmentId = Number(req.params.id);
  if (!Number.isInteger(assessmentId)) {
    return res.redirect('/dashboard?error=' + encodeURIComponent('Invalid assessment.'));
  }

  const current = req.session.currentAssessment;
  if (!current || !current.quiz || !current.subject || !Array.isArray(current.userAnswers)) {
    return res.redirect('/dashboard?error=' + encodeURIComponent('No active assessment found.'));
  }

  const { subject, quiz, userAnswers } = current;

  const { syllabus, level } = await aiController.evaluateAndCreateSyllabus(subject, userAnswers, quiz);

  const courseResult = await query(
    'INSERT INTO courses (user_id, topic, level, syllabus_json, progress, completed_modules) VALUES (?, ?, ?, ?, ?, ?)',
    [req.session.user.id, subject, level, JSON.stringify(syllabus), 0, 0]
  );

  delete req.session.currentAssessment;
  res.redirect(`/course/${courseResult.insertId}`);
}

module.exports = {
  getDashboard,
  verifyModuleMastery,
  generateMapFromAssessment
};
