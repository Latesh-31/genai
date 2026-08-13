const { db } = require('../config/firebase');
const aiController = require('./aiController');

function asyncHandler(fn) {
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// Dashboard
async function getDashboard(req, res) {
  try {
    const userId = req.session.user.id;
    
    // Get user data
    const userDoc = await db.collection('users').doc(userId).get();
    const userData = userDoc.exists ? userDoc.data() : {};
    
    // Get user's courses
    const coursesSnapshot = await db.collection('courses')
      .where('userId', '==', userId)
      .orderBy('createdAt', 'desc')
      .get();
    
    const courses = [];
    coursesSnapshot.forEach(doc => {
      const course = { id: doc.id, ...doc.data() };
      courses.push(course);
    });

    // Get user's assessments
    const assessmentsSnapshot = await db.collection('assessments')
      .where('userId', '==', userId)
      .orderBy('createdAt', 'desc')
      .limit(10)
      .get();
    
    const assessments = [];
    assessmentsSnapshot.forEach(doc => {
      const assessment = { id: doc.id, ...doc.data() };
      assessments.push(assessment);
    });

    res.render('dashboard', {
      title: 'Dashboard',
      user: { id: userId, ...userData },
      courses,
      assessments
    });
  } catch (error) {
    console.error('Dashboard error:', error);
    res.render('dashboard', {
      title: 'Dashboard',
      user: req.session.user,
      courses: [],
      assessments: []
    });
  }
}

// Generate map from assessment
async function generateMapFromAssessment(req, res) {
  try {
    const assessmentId = req.params.id;
    const userId = req.session.user.id;
    
    const assessmentDoc = await db.collection('assessments')
      .where('userId', '==', userId)
      .where(admin.firestore.FieldPath.documentId(), '==', assessmentId)
      .get();
    
    if (assessmentDoc.empty) {
      return res.redirect('/dashboard?error=' + encodeURIComponent('Assessment not found.'));
    }

    const assessment = { id: assessmentDoc.docs[0].id, ...assessmentDoc.docs[0].data() };
    const { syllabus, level } = await aiController.evaluateAndCreateSyllabus(
      assessment.topic,
      assessment.userAnswers || [],
      assessment.quizQuestions || []
    );

    // Create course
    const courseRef = await db.collection('courses').add({
      userId,
      topic: assessment.topic,
      level,
      syllabus,
      progress: 0,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.redirect(`/course/${courseRef.id}`);
  } catch (error) {
    console.error('Generate map error:', error);
    res.redirect('/dashboard?error=' + encodeURIComponent('Failed to generate learning map.'));
  }
}

// Verify module mastery
async function verifyModuleMastery(req, res) {
  try {
    const courseId = req.params.id;
    const userId = req.session.user.id;
    const { moduleIndex, userAnswers } = req.body;

    const courseDoc = await db.collection('courses').doc(courseId).get();
    if (!courseDoc.exists || courseDoc.data().userId !== userId) {
      return res.status(404).json({ error: 'Course not found' });
    }

    const course = { id: courseId, ...courseDoc.data() };
    const module = course.syllabus[moduleIndex];

    if (!module || !module.exit_quiz) {
      return res.status(400).json({ error: 'Module quiz not found' });
    }

    // Grade the exit quiz
    const score = userAnswers.reduce((acc, answer, idx) => {
      return acc + (answer === module.exit_quiz[idx].correctIndex ? 1 : 0);
    }, 0);

    const passed = score >= 2; // Need at least 2/3 correct

    if (passed) {
      // Update completed modules
      const newCompletedModules = Math.max(course.completed_modules || 0, parseInt(moduleIndex) + 1);
      await db.collection('courses').doc(courseId).update({
        completed_modules: newCompletedModules
      });
    }

    res.json({ 
      passed, 
      score, 
      total: module.exit_quiz.length,
      feedback: passed ? 'Module completed! 🎉' : 'Keep studying and try again! 💪'
    });
  } catch (error) {
    console.error('Verify module error:', error);
    res.status(500).json({ error: 'Failed to verify module mastery.' });
  }
}

// Get lesson with caching
async function getLessonForTopic(courseId, moduleIndex, topicIndex, topicName, userLevel) {
  try {
    // Construct the document ID
    const docId = `${courseId}_${moduleIndex}_${topicIndex}`;
    const lessonDoc = await db.collection('lessons').doc(docId).get();

    // If exists, return cached content
    if (lessonDoc.exists) {
      return lessonDoc.data().content_json;
    }

    // Generate new lesson
    const lessonContent = await aiController.generateLesson(topicName, userLevel);

    // Cache the lesson
    await db.collection('lessons').doc(docId).set({
      title: lessonContent.title,
      content_json: lessonContent,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return lessonContent;
  } catch (error) {
    console.error('Get lesson error:', error);
    throw error;
  }
}

// Handle lesson completion
async function completeLesson(req, res) {
  try {
    const courseId = req.params.id;
    const userId = req.session.user.id;
    const { moduleIndex, topicIndex, xpEarned = 100 } = req.body;

    const courseDoc = await db.collection('courses').doc(courseId).get();
    if (!courseDoc.exists || courseDoc.data().userId !== userId) {
      return res.status(404).json({ error: 'Course not found' });
    }

    const course = { id: courseId, ...courseDoc.data() };

    // Check if lesson was already completed
    const completionDocId = `${userId}_${courseId}_${moduleIndex}_${topicIndex}`;
    const completionDoc = await db.collection('lesson_completions').doc(completionDocId).get();

    if (!completionDoc.exists) {
      // Create lesson completion record
      await db.collection('lesson_completions').doc(completionDocId).set({
        userId,
        courseId,
        moduleIndex,
        topicIndex,
        xpEarned,
        completedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      // Update user's total XP + streak
      const userDoc = await db.collection('users').doc(userId).get();
      const userData = userDoc.exists ? userDoc.data() : {};

      const todayStr = new Date().toISOString().split('T')[0];
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = yesterday.toISOString().split('T')[0];

      const lastLessonDate = userData.last_lesson_date || null;
      const currentStreak = Number(userData.streak_days || 0);

      let nextStreak = currentStreak;
      if (lastLessonDate === todayStr) {
        nextStreak = currentStreak;
      } else if (lastLessonDate === yesterdayStr) {
        nextStreak = currentStreak + 1;
      } else {
        nextStreak = 1;
      }

      await db.collection('users').doc(userId).update({
        total_xp: admin.firestore.FieldValue.increment(xpEarned),
        last_lesson_date: todayStr,
        streak_days: nextStreak
      });
    }

    res.json({ success: true, xpEarned });
  } catch (error) {
    console.error('Complete lesson error:', error);
    res.status(500).json({ error: 'Failed to complete lesson.' });
  }
}

module.exports = {
  getDashboard,
  generateMapFromAssessment,
  verifyModuleMastery,
  getLessonForTopic,
  completeLesson
};