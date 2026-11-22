// Lets `node --test` import ../src/index.js, which imports a JSON file without an attribute.
export async function load(url, context, next) {
  if (url.endsWith('.json')) return next(url, { ...context, importAttributes: { type: 'json' } });
  return next(url, context);
}
