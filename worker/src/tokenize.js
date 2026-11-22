// Shared by the index builder (Node) and the Worker so both tokenize identically.
const STOP = new Set(
  ('a an and are as at be but by can did do does for from how i if in into is it its me my of on or our so ' +
    'than that the their then there these they this to was what when where which who why will with you your ' +
    'should would could about tell explain please give show define meaning mean')
    .split(' ')
);

// Deliberately crude: it only has to map variants to the same token on both sides.
function stem(t) {
  if (/\d/.test(t)) return t;
  if (t.length > 4 && t.endsWith('ies')) t = t.slice(0, -3) + 'y';
  else if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss') && !t.endsWith('us') && !t.endsWith('is')) t = t.slice(0, -1);
  if (t.length > 5 && t.endsWith('ing')) t = t.slice(0, -3);
  else if (t.length > 4 && t.endsWith('ed') && !t.endsWith('eed')) t = t.slice(0, -2); // exceed, speed stay whole
  if (/([bdgmnprt])\1$/.test(t) && t.length > 3) t = t.slice(0, -1); // getting→get, stopped→stop
  if (t.length > 3 && t.endsWith('e')) t = t.slice(0, -1);
  return t;
}

export function tokenize(text) {
  return String(text)
    .replace(/\b([a-z])\/([a-z])\b/gi, '$1$2') // P/E → pe, R/R → rr (else both letters are dropped)
    .replace(/\b(\d+)\s*[x×]\b/gi, '$1 ') // 16x / 16× → 16
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !STOP.has(t) && (t.length > 1 || /\d/.test(t)))
    .map(stem);
}

// Unstemmed content words, for engines that stem on their own (D1 FTS5 porter).
export function contentWords(text) {
  return [...new Set(
    String(text).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .split(/[^a-z0-9]+/)
      .filter((t) => t && !STOP.has(t) && (t.length > 2 || /\d/.test(t)))
  )];
}
