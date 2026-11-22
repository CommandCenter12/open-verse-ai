import { register } from 'node:module';
register('./register-json-loader.mjs', import.meta.url);

// Tests never touch the real network. Tests that need HTTP install a stub via
// globalThis.__fetchStub = async (url) => Response.
globalThis.fetch = async (input) => {
  const url = typeof input === 'string' ? input : input.url;
  if (globalThis.__fetchStub) return globalThis.__fetchStub(url);
  throw new Error(`network disabled in tests: ${url}`);
};
