import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  COLORS,
  dealQuestion,
  normalizeQuiz,
  parseQuizText,
  questionOrder,
  shuffle,
} from '../lib/quiz.js';

const four = {
  question: 'Which planet is famous for its rings?',
  answers: ['Jupiter', 'Saturn', 'Mars', 'Venus'],
  correct: 1,
};

test('shuffle and question order can be fixed or randomised', () => {
  const original = [1, 2, 3];
  const once = shuffle(original, () => 0);
  assert.deepEqual(original, [1, 2, 3]);
  assert.deepEqual(once, [2, 3, 1]);
  assert.deepEqual(shuffle([7]), [7]);
  assert.deepEqual(questionOrder(0, true), []);
  assert.deepEqual(questionOrder(4, false, () => 0), [0, 1, 2, 3]);
  const randomised = questionOrder(4, true, () => 0);
  assert.deepEqual(randomised, [1, 2, 3, 0]);
  assert.equal(questionOrder(3, true).length, 3);
});

test('dealing keeps or shuffles answers and uses red for false', () => {
  const fixed = dealQuestion(four, () => 0, false);
  assert.equal(fixed.text, four.question);
  assert.deepEqual(fixed.options.map((option) => option.text), four.answers);
  assert.deepEqual(fixed.options.map((option) => option.color), ['green', 'yellow', 'blue', 'red']);
  assert.equal(fixed.correctIndex, 1);
  assert.equal(fixed.options.filter((option) => option.correct).length, 1);

  const shuffled = dealQuestion(four, () => 0, true);
  assert.deepEqual(shuffled.options.map((option) => option.text), ['Saturn', 'Mars', 'Venus', 'Jupiter']);
  assert.equal(shuffled.correctIndex, 0);

  const boolQuestion = { question: 'Sky?', answers: ['True', 'False'], correct: 0 };
  const dealt = dealQuestion(boolQuestion, () => 0, false);
  assert.deepEqual(dealt.options.map((option) => `${option.text}:${option.color}:${option.shape}`), [
    'True:green:triangle',
    'False:red:square',
  ]);
  assert.equal(COLORS.length, 4);
});

test('JSON quizzes accept four answers, true or false, and a title fallback', () => {
  const parsed = parseQuizText('my-file.json', JSON.stringify([
    { question: '  Hello   there ', answers: ['A', 'B', 'C', 'D'], correct: '  b ' },
  ]));
  assert.equal(parsed.title, 'my file');
  assert.equal(parsed.questions[0].question, 'Hello there');
  assert.equal(parsed.questions[0].correct, 1);

  const titled = parseQuizText('.json', JSON.stringify({
    title: '   ',
    questions: [{ question: 'Sky is blue?', trueFalse: true, correct: false }],
  }));
  assert.equal(titled.title, 'Quiz');
  assert.deepEqual(titled.questions[0].answers, ['True', 'False']);
  assert.equal(titled.questions[0].correct, 1);

  for (const type of ['truefalse', 'true-false', 'boolean', 'TRUEFALSE']) {
    const quiz = normalizeQuiz({
      questions: [{ question: 'Q', type, correct: true }],
    }, 'Fallback');
    assert.equal(quiz.questions[0].correct, 0);
  }

  const exact = normalizeQuiz({
    title: 'Named',
    questions: [{ question: 'Q', answers: ['True', 'False'], correct: 'false' }],
  });
  assert.equal(exact.title, 'Named');
  assert.equal(exact.questions[0].correct, 1);
});

test('CSV quizzes accept quotes, blank true or false rows, and odd line endings', () => {
  const csv = [
    'question,answer1,answer2,answer3,answer4,correct',
    '"What, ""really""?",A,B,C,D,3',
    'Only two,True,False,,,True',
    '',
    '"Line\nkept",Yes,No,Maybe,Later,Yes',
  ].join('\r\n') + '\n';
  const withQuoteNewline = 'question,answer1,answer2,answer3,answer4,correct\r"two\nlines",True,False,,,1';
  const quiz = parseQuizText('sheet.csv', `\uFEFF${csv}`);
  assert.equal(quiz.title, 'sheet');
  assert.equal(quiz.questions[0].question, 'What, "really"?');
  assert.equal(quiz.questions[0].correct, 2);
  assert.deepEqual(quiz.questions[1].answers, ['True', 'False']);
  assert.equal(quiz.questions[1].correct, 0);
  assert.equal(quiz.questions[2].question, 'Line kept');
  assert.equal(quiz.questions[2].correct, 0);

  const multiline = parseQuizText('sheet.csv', withQuoteNewline);
  assert.equal(multiline.questions[0].question, 'two lines');
  assert.equal(multiline.questions[0].correct, 0);

  const noNewline = parseQuizText('sheet.csv', 'question,answer1,answer2,answer3,answer4,correct\nLast,A,B,C,D,4');
  assert.equal(noNewline.questions[0].correct, 3);
});

test('invalid quizzes explain what to fix', () => {
  const failures = [
    ['notes.txt', '{}', /json or \.csv/],
    ['x.json', '{', /could not be parsed/],
    ['x.json', 'null', /empty/],
    ['x.json', '4', /empty/],
    ['x.json', '{"questions":[]}', /at least one/],
    ['x.json', JSON.stringify({ questions: Array.from({ length: 101 }, () => ({ question: 'Q', answers: ['A', 'B', 'C', 'D'], correct: 1 })) }), /at most 100/],
    ['x.json', '{"questions":[null]}', /Question 1 is missing/],
    ['x.json', '{"questions":[{"question":"  "}]}', /needs text/],
    ['x.json', JSON.stringify({ questions: [{ question: 'Q'.repeat(301), answers: ['A', 'B', 'C', 'D'], correct: 1 }] }), /too long/],
    ['x.json', '{"questions":[{"question":"Q"}]}', /4 answers, or True and False/],
    ['x.json', '{"questions":[{"question":"Q","answers":["A","B","C"]}]}', /4 answers, or True and False/],
    ['x.json', '{"questions":[{"question":"Q","answers":["A","","C","D"],"correct":1}]}', /answer 2 is empty/],
    ['x.json', JSON.stringify({ questions: [{ question: 'Q', answers: ['A'.repeat(121), 'B', 'C', 'D'], correct: 1 }] }), /answer 1 is too long/],
    ['x.json', '{"questions":[{"question":"Q","answers":["A","a","C","D"],"correct":1}]}', /the same/],
    ['x.json', '{"questions":[{"question":"Q","answers":["Yes","No"],"correct":true}]}', /match True or False/],
    ['x.json', '{"questions":[{"question":"Q","answers":["A","B","C","D"],"correct":0}]}', /1, 2, 3, or 4/],
    ['x.json', '{"questions":[{"question":"Q","answers":["True","False"],"correct":3}]}', /1 or 2/],
    ['x.json', '{"questions":[{"question":"Q","answers":["A","B","C","D"],"correct":"nope"}]}', /exact answer text/],
    ['x.csv', 'question,answer1\nQ,A', /CSV header/],
    ['x.csv', 'question,answer1,answer2,answer3,answer4,correct', /header and at least one/],
    ['x.csv', 'question,answer1,answer2,answer3,answer4,correct\nQ,True,False,Only,,,1', /answer 4 is empty/],
    ['x.json', '{"trueFalse":false,"questions":[{"question":"Q","correct":true}]}', /4 answers, or True and False/],
  ];
  for (const [name, text, pattern] of failures) {
    assert.throws(() => parseQuizText(name, text), pattern);
  }
});
