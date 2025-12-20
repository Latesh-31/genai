const { GoogleGenerativeAI } = require('@google/generative-ai');

function extractJsonFromText(text) {
  if (!text || typeof text !== 'string') {
    throw new Error('AI returned an empty response');
  }

  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    return JSON.parse(trimmed);
  } catch (_) {
    const match = trimmed.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
    if (!match) {
      throw new Error('AI returned invalid JSON');
    }

    try {
      return JSON.parse(match[1]);
    } catch (err) {
      throw new Error('AI returned invalid JSON');
    }
  }
}

function getModel() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('Missing GEMINI_API_KEY. Set it in your environment before using AI features.');
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  return genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL || 'gemini-1.5-flash' });
}

function validateQuiz(quiz) {
  if (!Array.isArray(quiz) || quiz.length !== 5) {
    throw new Error('AI quiz must be an array of exactly 5 questions');
  }

  quiz.forEach((q, idx) => {
    if (!q || typeof q !== 'object') {
      throw new Error(`Invalid quiz question at index ${idx}`);
    }
    if (typeof q.question !== 'string' || !q.question.trim()) {
      throw new Error(`Quiz question text missing at index ${idx}`);
    }
    if (!Array.isArray(q.options) || q.options.length !== 4 || q.options.some((o) => typeof o !== 'string')) {
      throw new Error(`Quiz options must be an array of 4 strings at index ${idx}`);
    }
    if (!Number.isInteger(q.correctIndex) || q.correctIndex < 0 || q.correctIndex > 3) {
      throw new Error(`Quiz correctIndex must be 0..3 at index ${idx}`);
    }
    if (q.weak_topic != null && typeof q.weak_topic !== 'string') {
      throw new Error(`Quiz weak_topic must be a string at index ${idx}`);
    }
  });

  return quiz;
}

async function generateQuiz(topic) {
  const model = getModel();

  const prompt = [
    'Return ONLY valid JSON. No markdown. No code fences.',
    'Generate a multiple-choice quiz based on the provided topic.',
    'Constraints:',
    '- Exactly 5 questions.',
    '- Each question must have exactly 4 options.',
    '- Include the correct answer index (0-3).',
    '- Add a short subtopic tag in weak_topic (e.g., "OAuth flows", "Normalization", "Big-O").',
    '',
    'JSON shape:',
    '[',
    '  {',
    '    "question": "...",',
    '    "options": ["...", "...", "...", "..."],',
    '    "correctIndex": 0,',
    '    "weak_topic": "..."',
    '  }',
    ']',
    '',
    `Topic: ${topic}`
  ].join('\n');

  const result = await model.generateContent(prompt);
  const text = result?.response?.text?.() || '';
  const parsed = extractJsonFromText(text);
  return validateQuiz(parsed);
}

async function gradeQuiz(topic, quiz, userAnswers) {
  const model = getModel();

  const prompt = [
    'Return ONLY valid JSON. No markdown. No code fences.',
    'You are grading a quiz submission.',
    'Use the provided quiz (including correctIndex) and the provided userAnswers to compute the score.',
    'Identify weak topics based on missed questions (use weak_topic from the question when available; otherwise infer).',
    '',
    'Return JSON with this shape:',
    '{',
    '  "score": 0,',
    '  "weak_topics": ["..."],',
    '  "feedback_text": "Short, actionable feedback.",',
    '  "per_question": [',
    '    { "index": 0, "correct": true, "weak_topic": "...", "note": "..." }',
    '  ]',
    '}',
    '',
    `Topic: ${topic}`,
    `Quiz: ${JSON.stringify(quiz)}`,
    `UserAnswers: ${JSON.stringify(userAnswers)}`
  ].join('\n');

  const result = await model.generateContent(prompt);
  const text = result?.response?.text?.() || '';
  const parsed = extractJsonFromText(text);

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('AI grading response was not an object');
  }
  if (!Number.isFinite(parsed.score)) {
    throw new Error('AI grading response missing score');
  }

  return {
    score: Math.max(0, Math.min(5, Math.round(parsed.score))),
    weak_topics: Array.isArray(parsed.weak_topics)
      ? parsed.weak_topics.filter((t) => typeof t === 'string' && t.trim()).slice(0, 10)
      : [],
    feedback_text: typeof parsed.feedback_text === 'string' ? parsed.feedback_text : '',
    per_question: Array.isArray(parsed.per_question) ? parsed.per_question : []
  };
}

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
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

function normalizeExitQuiz(exitQuiz, module) {
  if (!Array.isArray(exitQuiz) || exitQuiz.length !== 3) {
    return buildFallbackExitQuiz(module);
  }

  const normalized = exitQuiz
    .map((q) => {
      const options = Array.isArray(q?.options) ? q.options.filter((o) => typeof o === 'string') : [];
      const correctIndex = Number.isInteger(q?.correctIndex) ? q.correctIndex : 0;

      if (typeof q?.question !== 'string' || !q.question.trim() || options.length !== 4 || correctIndex < 0 || correctIndex > 3) {
        return null;
      }

      return {
        question: q.question.trim(),
        options,
        correctIndex,
        review_topic: typeof q.review_topic === 'string' ? q.review_topic.trim() : '',
        explanation: typeof q.explanation === 'string' ? q.explanation.trim() : ''
      };
    })
    .filter(Boolean);

  if (normalized.length !== 3) {
    return buildFallbackExitQuiz(module);
  }

  return normalized;
}

function computeDefaultNodePosition(idx, total) {
  const t = total > 1 ? idx / (total - 1) : 0;
  const y = clampNumber(12 + t * 76, 0, 100);
  const x = idx % 2 === 0 ? 24 : 76;

  return { x, y };
}

async function evaluateAndCreateSyllabus(subject, userAnswers, quizQuestions) {
  // 1. Grade the quiz
  const gradingResult = await gradeQuiz(subject, quizQuestions, userAnswers);
  const { score, weak_topics } = gradingResult;

  // 2. Generate Syllabus
  const model = getModel();

  const prompt = [
    'Return ONLY valid JSON. No markdown. No code fences.',
    'You are creating a personalized syllabus for a learner.',
    `User scored ${score} out of 5 on topic "${subject}".`,
    `Failed/Weak areas: ${weak_topics.length ? weak_topics.join(', ') : 'none'}.`,
    '',
    'Create a 6-module syllabus.',
    'If score is low (0-2), start with basics/fundamentals. If score is high (4-5), skip to advanced topics.',
    '',
    'Each module must be an object with:',
    '- title (string)',
    '- description (string)',
    '- topics (array of strings - subtopics to cover)',
    '- node (object with x,y numbers 0..100 for a mind-map layout; OPTIONAL but preferred)',
    '- exit_quiz (array of EXACTLY 3 multiple-choice questions to unlock the next module)',
    '',
    'Exit quiz question shape:',
    '{ "question": "...", "options": ["...", "...", "...", "..."], "correctIndex": 0, "review_topic": "...", "explanation": "..." }',
    '',
    'JSON shape:',
    '{',
    '  "syllabus": [',
    '    { "title": "...", "description": "...", "topics": ["...", "..."], "node": { "x": 50, "y": 20 }, "exit_quiz": [ ... ] }',
    '  ],',
    '  "level": "Beginner | Intermediate | Advanced"',
    '}',
  ].join('\n');

  const result = await model.generateContent(prompt);
  const text = result?.response?.text?.() || '';
  const parsed = extractJsonFromText(text);

  if (!parsed || !Array.isArray(parsed.syllabus) || parsed.syllabus.length !== 6) {
    throw new Error('AI syllabus must be an array of exactly 6 modules inside "syllabus" property');
  }

  // Sanitize + enrich with mind-map metadata
  const totalModules = parsed.syllabus.length;

  parsed.syllabus.forEach((m, idx) => {
    m.title = m.title || `Module ${idx + 1}`;
    m.description = m.description || '';
    m.topics = Array.isArray(m.topics) ? m.topics.filter((t) => typeof t === 'string' && t.trim()) : [];

    const rawNode = m.node && typeof m.node === 'object' ? m.node : null;
    const x = rawNode ? Number(rawNode.x) : NaN;
    const y = rawNode ? Number(rawNode.y) : NaN;

    const defaultNode = computeDefaultNodePosition(idx, totalModules);
    m.node = {
      x: clampNumber(Number.isFinite(x) ? x : defaultNode.x, 0, 100),
      y: clampNumber(Number.isFinite(y) ? y : defaultNode.y, 0, 100)
    };

    m.exit_quiz = normalizeExitQuiz(m.exit_quiz, m);
  });

  const level = parsed.level || (score < 3 ? 'Beginner' : score < 5 ? 'Intermediate' : 'Advanced');

  return {
    syllabus: parsed.syllabus,
    level,
    grading: gradingResult
  };
}

function validateLessonCards(cards) {
  if (!Array.isArray(cards) || cards.length === 0) {
    throw new Error('AI lesson must have at least one card');
  }

  cards.forEach((card, idx) => {
    if (!card || typeof card !== 'object') {
      throw new Error(`Invalid card at index ${idx}`);
    }
    
    if (!['text', 'quiz', 'challenge'].includes(card.type)) {
      throw new Error(`Card ${idx} must have type 'text', 'quiz', or 'challenge'`);
    }
    
    if (card.type === 'text') {
      if (typeof card.content !== 'string' || !card.content.trim()) {
        throw new Error(`Text card ${idx} must have content`);
      }
      if (card.image != null && typeof card.image !== 'string') {
        throw new Error(`Text card ${idx} image must be a string`);
      }
    }
    
    if (card.type === 'quiz') {
      if (typeof card.question !== 'string' || !card.question.trim()) {
        throw new Error(`Quiz card ${idx} must have a question`);
      }
      if (!Array.isArray(card.options) || card.options.length < 2) {
        throw new Error(`Quiz card ${idx} must have at least 2 options`);
      }
      card.options.forEach((opt, optIdx) => {
        if (typeof opt !== 'string') {
          throw new Error(`Quiz card ${idx} option ${optIdx} must be a string`);
        }
      });
      if (typeof card.answer !== 'string' || !card.answer.trim()) {
        throw new Error(`Quiz card ${idx} must have an answer`);
      }
      if (!card.options.includes(card.answer)) {
        throw new Error(`Quiz card ${idx} answer must be one of the options`);
      }
      if (typeof card.explanation !== 'string' || !card.explanation.trim()) {
        throw new Error(`Quiz card ${idx} must have an explanation`);
      }
    }
    
    if (card.type === 'challenge') {
      if (typeof card.prompt !== 'string' || !card.prompt.trim()) {
        throw new Error(`Challenge card ${idx} must have a prompt`);
      }
      if (typeof card.hint !== 'string' || !card.hint.trim()) {
        throw new Error(`Challenge card ${idx} must have a hint`);
      }
    }
  });

  return cards;
}

async function generateLesson(topic, userLevel) {
  const model = getModel();

  const prompt = [
    `You are a world-class tutor who explains "${topic}" to a ${userLevel} student.`,
    'Use the "Feynman Technique" (simple language, analogies).',
    'Use emojis and humor to make learning fun and engaging.',
    'Break the topic into bite-sized interactive learning moments.',
    'Output STRICT JSON with this structure:',
    '{',
    '  "title": "The basics of...",',
    '  "cards": [',
    '    {',
    '      "type": "text",',
    '      "content": "Imagine atoms are like LEGO bricks... 🏗️",',
    '      "image": "optional-image-url"',
    '    },',
    '    {',
    '      "type": "quiz",',
    '      "question": "So, are atoms visible?",',
    '      "options": ["Yes", "No", "Sometimes", "Only with microscope"],',
    '      "answer": "No",',
    '      "explanation": "Exactly! Atoms are too small to see with the naked eye! 👀"',
    '    },',
    '    {',
    '      "type": "challenge",',
    '      "prompt": "Explain atomic structure to a 5-year-old using an analogy",',
    '      "hint": "Think about building blocks or LEGO! 🧱"',
    '    }',
    '  ]',
    '}'
  ].join('\n');

  const result = await model.generateContent(prompt);
  const text = result?.response?.text?.() || '';
  
  if (!text) throw new Error('AI failed to generate lesson content');
  
  const parsed = extractJsonFromText(text);
  
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('AI lesson response was not an object');
  }
  if (typeof parsed.title !== 'string' || !parsed.title.trim()) {
    throw new Error('AI lesson response missing title');
  }
  if (!parsed.cards || !Array.isArray(parsed.cards)) {
    throw new Error('AI lesson response missing cards array');
  }

  return {
    title: parsed.title,
    cards: validateLessonCards(parsed.cards)
  };
}

async function generateTutorResponse({ question, courseTopic, userLevel, lessonTopic, lessonText }) {
  const model = getModel();

  const context = typeof lessonText === 'string' ? lessonText.slice(0, 6000) : '';

  const prompt = [
    'You are AdaptLearn AI Tutor.',
    'Answer the user question clearly and concisely.',
    'Use Markdown formatting.',
    'If the question is ambiguous, ask 1 short clarifying question and still provide a best-effort answer.',
    `Course topic: ${courseTopic || ''}`,
    `Student level: ${userLevel || ''}`,
    lessonTopic ? `Current lesson topic: ${lessonTopic}` : '',
    context ? `Lesson context:\n${context}` : '',
    `User question: ${question}`
  ]
    .filter(Boolean)
    .join('\n\n');

  const result = await model.generateContent(prompt);
  const text = result?.response?.text?.() || '';

  if (!text) throw new Error('AI failed to generate tutor response');

  let cleanText = text.trim();
  if (cleanText.startsWith('```markdown')) {
    cleanText = cleanText.replace(/^```markdown\s*/i, '').replace(/\s*```$/i, '');
  } else if (cleanText.startsWith('```') && !cleanText.includes('\n```', 4)) {
    cleanText = cleanText.replace(/^```\s*/i, '').replace(/\s*```$/i, '');
  }

  return cleanText;
}

module.exports = {
  generateQuiz,
  gradeQuiz,
  evaluateAndCreateSyllabus,
  generateLesson,
  generateTutorResponse
};
