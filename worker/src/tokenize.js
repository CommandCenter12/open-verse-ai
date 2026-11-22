// Shared by the index builder (Node) and the Worker so both tokenize identically.
const STOP = new Set(
  ('a an and are as at be but by can do does for from how i if in into is it its me my of on or our so ' +
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
  else if (t.length > 4 && t.endsWith('ed')) t = t.slice(0, -2);
  if (t.length > 3 && t.endsWith('e')) t = t.slice(0, -1);
  return t;
}

export function tokenize(text) {
  return String(text)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !STOP.has(t) && (t.length > 1 || /\d/.test(t)))
    .map(stem);
}
