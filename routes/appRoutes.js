const express = require('express');
const router = express.Router();
const aiController = require('../controllers/aiController');
const appController = require('../controllers/appController');

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

    // Store assessment in Firestore
    const { db, admin } = require('../config/firebase');
    const assessmentRef = await db.collection('assessments').add({
      userId: req.session.user.id,
      topic: subject,
      score: grading.score,
      feedback_text: grading.feedback_text,
      analysis_json: analysis,
      userAnswers,
      quizQuestions: quiz,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    req.session.currentAssessment = {
      ...current,
      userAnswers,
      grading,
      assessmentId: assessmentRef.id
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
      assessmentId: assessmentRef.id
    });
  } catch (err) {
    console.error(err);
    res.redirect('/dashboard?error=' + encodeURIComponent(err.message || 'Failed to process quiz results.'));
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
// POST /assessment/:id/generate-map
router.post('/assessment/:id/generate-map', requireAuth, asyncHandler(appController.generateMapFromAssessment));

// GET /course/:id
router.get('/course/:id', requireAuth, asyncHandler(async (req, res) => {
  const courseId = req.params.id;
  const { db } = require('../config/firebase');
  
  const courseDoc = await db.collection('courses').doc(courseId).get();
  
  if (!courseDoc.exists || courseDoc.data().userId !== req.session.user.id) {
    return res.redirect('/dashboard?error=' + encodeURIComponent('Course not found.'));
  }

  const course = { id: courseId, ...courseDoc.data() };

  res.render('course', {
    title: course.topic,
    course,
    syllabus: course.syllabus || []
  });
}));

// GET /course/:id/lesson/:moduleIndex/:topicIndex
router.get('/course/:id/lesson/:moduleIndex/:topicIndex', requireAuth, asyncHandler(async (req, res) => {
  const { id, moduleIndex, topicIndex } = req.params;
  
  const { db } = require('../config/firebase');
  const courseDoc = await db.collection('courses').doc(id).get();
  
  if (!courseDoc.exists || courseDoc.data().userId !== req.session.user.id) {
    return res.status(404).json({ error: 'Course not found' });
  }

  const course = { id, ...courseDoc.data() };
  const syllabus = course.syllabus || [];

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
  const lessonContent = await appController.getLessonForTopic(id, modIdx, topIdx, topicName, course.level);

  res.json(lessonContent);
}));

// POST /course/:id/complete
router.post('/course/:id/complete', requireAuth, asyncHandler(appController.completeLesson));

// POST /course/:id/verify-module
router.post('/course/:id/verify-module', requireAuth, asyncHandler(appController.verifyModuleMastery));

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
  const courseId = req.params.id;
  const { db } = require('../config/firebase');
  
  const courseDoc = await db.collection('courses').doc(courseId).get();

  if (!courseDoc.exists || courseDoc.data().userId !== req.session.user.id) {
    return res.status(404).json({ error: 'Course not found' });
  }

  const question = (req.body.question || '').trim();
  if (!question) {
    return res.status(400).json({ error: 'Question is required' });
  }

  const lessonTopic = typeof req.body.lessonTopic === 'string' ? req.body.lessonTopic.trim() : '';
  const lessonText = typeof req.body.lessonText === 'string' ? req.body.lessonText : '';

  const course = { ...courseDoc.data() };

  const answer = await aiController.generateTutorResponse({
    question,
    courseTopic: course.topic,
    userLevel: course.level,
    lessonTopic,
    lessonText
  });

  res.json({ answer });
}));

// NEW: POST /course/:id/chat - AI Chatbot endpoint
router.post('/course/:id/chat', requireAuth, asyncHandler(async (req, res) => {
  const courseId = req.params.id;
  const { db } = require('../config/firebase');
  
  const courseDoc = await db.collection('courses').doc(courseId).get();

  if (!courseDoc.exists || courseDoc.data().userId !== req.session.user.id) {
    return res.status(404).json({ error: 'Course not found' });
  }

  const { question, lessonContext } = req.body;

  if (!question || !question.trim()) {
    return res.status(400).json({ error: 'Question is required' });
  }

  try {
    const answer = await aiController.getChatResponse(question.trim(), lessonContext || '');
    res.json({ answer });
  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({ error: 'Failed to get AI response.' });
  }
}));

module.exports = router;