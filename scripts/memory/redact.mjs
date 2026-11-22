// Removes secrets and contact details before anything is chunked or uploaded.
// Pattern-based: it reduces risk, it does not guarantee removal. Review chunks.jsonl.

function luhn(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

// Order matters: specific token formats before generic ones.
const RULES = [
  ['private_key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  ['api_key', /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}|ova_[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|xox[abprs]-[A-Za-z0-9-]{10,}|hf_[A-Za-z0-9]{20,})\b/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
  ['bearer', /\b(Bearer)\s+[A-Za-z0-9._~+/-]{20,}=*/g],
  ['secret_assignment', /\b(password|passwd|pwd|secret|token|api[_-]?key|client[_-]?secret)(\s*[:=]\s*)["']?[^\s"']{6,}["']?/gi],
  ['email', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g],
  ['iban', /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}(?:\s?[A-Z0-9]{1,3})?\b/g],
  ['card', /\b(?:\d[ -]?){13,19}\b/g],
  ['ssn', /\b\d{3}-\d{2}-\d{4}\b/g],
  // Sentence-ending punctuation after a number is fine ("call +1 415-555-0199."); a following digit is not.
  ['phone', /(?<![\w.])\+?\d{1,3}?[ .-]?\(?\d{2,4}\)?[ .-]\d{3,4}[ .-]\d{3,4}(?!\w|[.-]\d)/g],
  ['long_hex', /\b[a-f0-9]{40,}\b/gi],
];

export function redact(text, allow = []) {
  const counts = {};
  let out = String(text);
  for (const [name, re] of RULES) {
    out = out.replace(re, (match, g1, g2) => {
      if (allow.some((a) => a && match.includes(a))) return match;
      if (name === 'card' && !luhn(match.replace(/\D/g, ''))) return match;
      counts[name] = (counts[name] || 0) + 1;
      if (name === 'bearer') return `${g1} [REDACTED_TOKEN]`;
      if (name === 'secret_assignment') return `${g1}${g2}[REDACTED_SECRET]`;
      return `[REDACTED_${name.toUpperCase()}]`;
    });
  }
  return { text: out, counts };
}
