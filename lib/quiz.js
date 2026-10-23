import crypto from 'node:crypto';

export const COLORS = [
  { id: 'green', shape: 'triangle' },
  { id: 'yellow', shape: 'diamond' },
  { id: 'blue', shape: 'circle' },
  { id: 'red', shape: 'square' },
];

const QUESTION_MAX = 300;
const ANSWER_MAX = 120;

export function shuffle(items, randomInt = crypto.randomInt) {
  const copy = items.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export function questionOrder(count, randomise, randomInt = crypto.randomInt) {
  const indexes = Array.from({ length: count }, (_, index) => index);
  return randomise ? shuffle(indexes, randomInt) : indexes;
}

export function dealQuestion(question, randomInt = crypto.randomInt, shuffleAnswers = true) {
  const indexes = question.answers.map((_, index) => index);
  const palette = indexes.length === 2 ? [COLORS[0], COLORS[3]] : COLORS;
  const slots = shuffleAnswers ? shuffle(indexes, randomInt) : indexes;
  const options = slots.map((answerIndex, colorIndex) => ({
    text: question.answers[answerIndex],
    color: palette[colorIndex].id,
    shape: palette[colorIndex].shape,
    correct: answerIndex === question.correct,
  }));
  return {
    text: question.question,
    options,
    correctIndex: options.findIndex((option) => option.correct),
  };
}

export function parseQuizText(filename, text) {
  const raw = String(text ?? '').replace(/^\uFEFF/, '');
  const ext = filename.toLowerCase().endsWith('.csv') ? 'csv' : 'json';
  if (!filename.toLowerCase().endsWith('.json') && ext !== 'csv') {
    throw new Error('Quiz files must be .json or .csv.');
  }
  const fallbackTitle = filename.replace(/\.(json|csv)$/i, '').replace(/[-_]+/g, ' ').trim() || 'Quiz';
  if (ext === 'csv') return normalizeQuiz(csvToDocument(raw, fallbackTitle), fallbackTitle);
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error('That JSON file could not be parsed.');
  }
  return normalizeQuiz(data, fallbackTitle);
}

function csvToDocument(text, title) {
  const rows = parseCsv(text).filter((row) => row.some((cell) => cell.trim() !== ''));
  if (rows.length < 2) throw new Error('The CSV needs a header and at least one question.');
  const header = rows[0].map((cell) => cell.trim().toLowerCase());
  const expected = ['question', 'answer1', 'answer2', 'answer3', 'answer4', 'correct'];
  if (header.length !== expected.length || expected.some((name, index) => header[index] !== name)) {
    throw new Error('CSV header must be question,answer1,answer2,answer3,answer4,correct');
  }
  return {
    title,
    questions: rows.slice(1).map((row) => ({
      question: row[0] ?? '',
      answers: csvAnswers(row),
      correct: (row[5] ?? '').trim(),
    })),
  };
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell);
      cell = '';
      rows.push(row);
      row = [];
    } else {
      cell += char;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

export function normalizeQuiz(data, fallbackTitle) {
  const source = Array.isArray(data) ? { questions: data } : data;
  if (!source || typeof source !== 'object') throw new Error('The quiz file is empty.');
  const title = String(source.title ?? fallbackTitle ?? 'Quiz').trim() || 'Quiz';
  if (!Array.isArray(source.questions) || source.questions.length === 0) {
    throw new Error('Add at least one question.');
  }
  if (source.questions.length > 100) throw new Error('A quiz can have at most 100 questions.');
  const questions = source.questions.map((entry, index) => normalizeQuestion(entry, index));
  return { title, questions };
}

function csvAnswers(row) {
  const cells = [1, 2, 3, 4].map((index) => row[index] ?? '');
  if (String(cells[2]).trim() === '' && String(cells[3]).trim() === '') return cells.slice(0, 2);
  return cells;
}

function wantsTrueFalse(entry) {
  if (entry.trueFalse === true) return true;
  const type = String(entry.type ?? '').trim().toLowerCase();
  return type === 'truefalse' || type === 'true-false' || type === 'boolean';
}

function normalizeQuestion(entry, index) {
  const label = `Question ${index + 1}`;
  if (!entry || typeof entry !== 'object') throw new Error(`${label} is missing.`);
  const question = String(entry.question ?? '').replace(/\s+/g, ' ').trim();
  if (!question) throw new Error(`${label} needs text.`);
  if (question.length > QUESTION_MAX) throw new Error(`${label} is too long.`);
  const provided = Array.isArray(entry.answers) ? entry.answers : null;
  const source = provided ?? (wantsTrueFalse(entry) ? ['True', 'False'] : null);
  if (!source || (source.length !== 2 && source.length !== 4)) {
    throw new Error(`${label} needs 4 answers, or True and False.`);
  }
  const answers = source.map((answer) => String(answer ?? '').replace(/\s+/g, ' ').trim());
  answers.forEach((answer, answerIndex) => {
    if (!answer) throw new Error(`${label} answer ${answerIndex + 1} is empty.`);
    if (answer.length > ANSWER_MAX) throw new Error(`${label} answer ${answerIndex + 1} is too long.`);
  });
  if (new Set(answers.map((answer) => answer.toLowerCase())).size !== answers.length) {
    throw new Error(`${label} has two answers that are the same.`);
  }
  return { question, answers, correct: resolveCorrect(answers, entry.correct, label) };
}

function resolveCorrect(answers, correct, label) {
  if (typeof correct === 'boolean') {
    const wanted = correct ? 'true' : 'false';
    const index = answers.findIndex((answer) => answer.toLowerCase() === wanted);
    if (index >= 0) return index;
    throw new Error(`${label}: correct must match True or False.`);
  }
  if (typeof correct === 'string') {
    const trimmed = correct.trim();
    const exact = answers.findIndex((answer) => answer === trimmed);
    if (exact >= 0) return exact;
    const folded = answers.findIndex((answer) => answer.toLowerCase() === trimmed.toLowerCase());
    if (folded >= 0) return folded;
  }
  const numeric = typeof correct === 'number' ? correct : Number(String(correct ?? '').trim());
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > answers.length) {
    const choices = answers.length === 2 ? '1 or 2' : '1, 2, 3, or 4';
    throw new Error(`${label}: correct must be ${choices}, or the exact answer text.`);
  }
  return numeric - 1;
}
