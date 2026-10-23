// 0 seconds -> 1000 points, full time -> 250 points, linear in between.
// A wrong or missing answer scores 0.
// Each extra correct answer in a row adds 0.1 to the multiplier: x1, x1.1, x1.2, ...
export function pointsFor(elapsedMs, correct, durationMs = 20000, streak = 1) {
  if (!correct) return 0;
  const span = durationMs > 0 ? durationMs : 20000;
  const elapsed = Math.min(span, Math.max(0, elapsedMs));
  const base = 1000 - (elapsed / span) * 750;
  return Math.round(base * streakTenths(streak) / 10);
}

export function multiplierLabel(streak) {
  const tenths = streakTenths(streak);
  const whole = Math.floor(tenths / 10);
  const fraction = tenths % 10;
  return fraction === 0 ? `x${whole}` : `x${whole}.${fraction}`;
}

function streakTenths(streak) {
  const count = Math.max(1, Math.floor(Number(streak) || 1));
  return 10 + (count - 1);
}
