// Public config only. Never put secrets here: everything in /site is public.
// Local pages use the local Worker; everything else uses the deployed Worker.
window.OVA_CONFIG = {
  API_BASE: location.hostname === 'localhost' || location.hostname === '127.0.0.1'
    ? 'http://localhost:8787'
    : 'https://open-verse-ai.boukeilehm.workers.dev',
};
