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

async function generateSyllabus(topic, quizResults) {
  const model = getModel();

  const score = quizResults?.score ?? 'unknown';
  const weakTopics = Array.isArray(quizResults?.weak_topics) ? quizResults.weak_topics : [];

  const prompt = [
    'Return ONLY valid JSON. No markdown. No code fences.',
    'You are creating a personalized syllabus for a learner.',
    `User scored ${score} out of 5 on topic "${topic}".`,
    `They struggled with: ${weakTopics.length ? weakTopics.join(', ') : 'unspecified weak areas'}.`,
    '',
    'Generate a 6-module syllabus that prioritizes the weaknesses but still covers fundamentals in a coherent progression.',
    'Return an array of exactly 6 modules. Each module must be an object with:',
    '- title (string)',
    '- summary (string)',
    '- objectives (array of 3-6 bullet strings)',
    '- practice (array of 2-4 bullet strings)',
    '',
    'Example shape:',
    '[',
    '  { "title": "Module 1: ...", "summary": "...", "objectives": ["..."], "practice": ["..."] }',
    ']',
    '',
    `Quiz results context: ${JSON.stringify(quizResults)}`
  ].join('\n');

  const result = await model.generateContent(prompt);
  const text = result?.response?.text?.() || '';
  const parsed = extractJsonFromText(text);

  if (!Array.isArray(parsed) || parsed.length !== 6) {
    throw new Error('AI syllabus must be an array of exactly 6 modules');
  }

  parsed.forEach((m, idx) => {
    if (!m || typeof m !== 'object') throw new Error(`Invalid module at index ${idx}`);
    if (typeof m.title !== 'string' || !m.title.trim()) throw new Error(`Module title missing at index ${idx}`);
    if (typeof m.summary !== 'string') throw new Error(`Module summary missing at index ${idx}`);
    if (!Array.isArray(m.objectives)) throw new Error(`Module objectives missing at index ${idx}`);
    if (!Array.isArray(m.practice)) throw new Error(`Module practice missing at index ${idx}`);
  });

  return parsed;
}

module.exports = {
  generateQuiz,
  gradeQuiz,
  generateSyllabus
};
