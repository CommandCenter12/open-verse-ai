// Exact arithmetic for questions like "1+1" or "what is (3.5 * 2)^2?".
// A small recursive-descent parser: no eval, no variables, no functions.

const PREFIX = /^\s*(what\s+is|what's|calculate|compute|evaluate|solve)\s+/i;

export function extractExpression(question) {
  let s = question.replace(PREFIX, '').replace(/[?=\s]+$/, '').trim();
  s = s.replace(/×/g, '*').replace(/÷/g, '/').replace(/−/g, '-').replace(/\*\*/g, '^');
  if (!s || s.length > 200) return null;
  if (!/^[\d.\s+\-*/^%()]+$/.test(s)) return null; // arithmetic characters only
  if (!/\d/.test(s) || !/[+\-*/^%]/.test(s.replace(/^\s*-/, ''))) return null; // needs an operator
  return s;
}

function parse(src) {
  const tokens = src.match(/\d+(?:\.\d+)?|\.\d+|[+\-*/^%()]/g) || [];
  if (tokens.join('') !== src.replace(/\s+/g, '')) throw new Error('bad token');
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];

  // expr := term (('+'|'-') term)*
  function expr() {
    let v = term();
    while (peek() === '+' || peek() === '-') v = next() === '+' ? v + term() : v - term();
    return v;
  }
  // term := unary (('*'|'/'|'%') unary)*
  function term() {
    let v = unary();
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = next();
      const r = unary();
      if ((op === '/' || op === '%') && r === 0) throw new Error('division by zero');
      v = op === '*' ? v * r : op === '/' ? v / r : v % r;
    }
    return v;
  }
  // unary := '-' unary | power   (so -2^2 = -4, matching math convention)
  function unary() {
    if (peek() === '-') { next(); return -unary(); }
    if (peek() === '+') { next(); return unary(); }
    return power();
  }
  // power := atom ('^' unary)?   (right-associative)
  function power() {
    const base = atom();
    if (peek() === '^') { next(); return base ** unary(); }
    return base;
  }
  function atom() {
    const t = next();
    if (t === '(') {
      const v = expr();
      if (next() !== ')') throw new Error('missing )');
      return v;
    }
    if (t !== undefined && /^[\d.]/.test(t)) return Number(t);
    throw new Error('unexpected token');
  }

  const v = expr();
  if (i !== tokens.length) throw new Error('trailing input');
  return v;
}

function format(n) {
  if (Number.isInteger(n) && Math.abs(n) < 1e21) return String(n);
  return String(Number(n.toPrecision(12)));
}

// Returns { expression, result } or null when the question isn't plain arithmetic.
// Throws a user-facing Error for arithmetic that is invalid (e.g. division by zero).
export function tryMath(question) {
  const expression = extractExpression(question);
  if (!expression) return null;
  let value;
  try {
    value = parse(expression);
  } catch (err) {
    if (err.message === 'division by zero') return { expression, error: 'Division by zero is undefined.' };
    return null; // not a well-formed expression: let other answerers try
  }
  if (!Number.isFinite(value)) return { expression, error: 'The result is too large to represent.' };
  return { expression, result: format(value) };
}
