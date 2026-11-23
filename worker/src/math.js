// Exact arithmetic for questions like "1+1" or "what is (3.5 * 2)^2?", and the
// `calculate` tool the model uses for every number in longer problems.
// A small recursive-descent parser: no eval, no variables. Named functions and
// constants (sqrt, ln, pi, …) are allowed only through evaluate(), i.e. the tool.

const PREFIX = /^\s*(what\s+is|what's|calculate|compute|evaluate|solve)\s+/i;

export function extractExpression(question) {
  let s = question.replace(PREFIX, '').replace(/[?=\s]+$/, '').trim();
  s = s.replace(/×/g, '*').replace(/÷/g, '/').replace(/−/g, '-').replace(/\*\*/g, '^');
  if (!s || s.length > 200) return null;
  if (!/^[\d.\s+\-*/^%()]+$/.test(s)) return null; // arithmetic characters only
  if (!/\d/.test(s) || !/[+\-*/^%]/.test(s.replace(/^\s*-/, ''))) return null; // needs an operator
  return s;
}

const FUNCS = {
  sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs, exp: Math.exp,
  ln: Math.log, log: (x, b) => (b === undefined ? Math.log10(x) : Math.log(x) / Math.log(b)), log10: Math.log10, log2: Math.log2,
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: Math.atan2,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
  round: (x, d = 0) => Math.round(x * 10 ** d) / 10 ** d, floor: Math.floor, ceil: Math.ceil,
  min: Math.min, max: Math.max, pow: Math.pow, hypot: Math.hypot,
  deg: (x) => (x * 180) / Math.PI, rad: (x) => (x * Math.PI) / 180,
};
const CONSTS = { pi: Math.PI, e: Math.E, tau: 2 * Math.PI };

function parse(src, { functions = false } = {}) {
  const tokens = src.match(/\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\.\d+|[A-Za-z_][A-Za-z0-9_]*|[+\-*/^%(),]/g) || [];
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
    if (functions && t !== undefined && /^[A-Za-z_]/.test(t)) {
      const name = t.toLowerCase();
      if (peek() === '(') {
        const fn = FUNCS[name];
        if (!fn) throw new Error(`unknown function ${t}`);
        next();
        const args = [];
        if (peek() !== ')') { args.push(expr()); while (peek() === ',') { next(); args.push(expr()); } }
        if (next() !== ')') throw new Error('missing )');
        return fn(...args);
      }
      if (name in CONSTS) return CONSTS[name];
      throw new Error(`unknown name ${t}`);
    }
    throw new Error('unexpected token');
  }

  const v = expr();
  if (i !== tokens.length) throw new Error('trailing input');
  return v;
}

// For the model's `calculate` tool: functions/constants allowed, friendly errors, never throws.
export function evaluate(expression) {
  let s = String(expression || '').trim().replace(/×/g, '*').replace(/÷/g, '/').replace(/−/g, '-').replace(/\*\*/g, '^').replace(/\s+/g, ' ');
  if (!/[A-Za-z]/.test(s)) s = s.replace(/(\d),(?=\d{3}(?!\d))/g, '$1'); // 18,500 → 18500 (only when no f(a, b))
  if (!s) return { expression: s, error: 'empty expression' };
  if (s.length > 300) return { expression: s.slice(0, 40) + '…', error: 'expression too long' };
  try {
    const v = parse(s, { functions: true });
    if (!Number.isFinite(v)) return { expression: s, error: Number.isNaN(v) ? 'not a real number (check the inputs)' : 'result is infinite' };
    return { expression: s, result: format(v) };
  } catch (err) {
    return { expression: s, error: err.message === 'division by zero' ? 'division by zero' : `could not evaluate: ${err.message}` };
  }
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
