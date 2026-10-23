import assert from 'node:assert/strict';
import { test } from 'node:test';
import { multiplierLabel, pointsFor } from '../lib/score.js';

test('points scale from 1000 to 250 and ignore wrong answers', () => {
  assert.equal(pointsFor(0, true, 20000, 1), 1000);
  assert.equal(pointsFor(20000, true, 20000, 1), 250);
  assert.equal(pointsFor(10000, true, 20000, 1), 625);
  assert.equal(pointsFor(0, false, 20000, 4), 0);
  assert.equal(pointsFor(-50, true, 20000, 1), 1000);
  assert.equal(pointsFor(99999, true, 20000, 1), 250);
});

test('a missing or invalid duration falls back to 20 seconds', () => {
  assert.equal(pointsFor(0, true, 0, 1), 1000);
  assert.equal(pointsFor(0, true, -5, 1), 1000);
});

test('correct streaks multiply by a tenth each time', () => {
  assert.deepEqual(
    [1, 2, 3, 4, 11, 12].map((streak) => pointsFor(0, true, 20000, streak)),
    [1000, 1100, 1200, 1300, 2000, 2100],
  );
  assert.equal(pointsFor(20000, true, 20000, 2), 275);
  assert.equal(pointsFor(0, true, 20000, 1.9), 1000);
  assert.equal(pointsFor(0, true, 20000, 0), 1000);
  assert.equal(pointsFor(0, true, 20000, 'nope'), 1000);
});

test('multiplier labels follow x1, x1.1, x1.2', () => {
  assert.deepEqual(
    [1, 2, 3, 4, 10, 11, 0, 2.8].map((streak) => multiplierLabel(streak)),
    ['x1', 'x1.1', 'x1.2', 'x1.3', 'x1.9', 'x2', 'x1', 'x1.1'],
  );
});
