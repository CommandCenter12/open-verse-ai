// Public config only. Never put secrets here: everything in /site is public.
// Set this to your deployed Worker URL, e.g. https://open-verse-ai.<subdomain>.workers.dev
window.OVA_CONFIG = {
  API_BASE: location.hostname === 'localhost' || location.hostname === '127.0.0.1'
    ? 'http://localhost:8787'
    : 'https://open-verse-ai.<your-subdomain>.workers.dev',
};
