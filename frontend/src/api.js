// Thin wrapper over the backend REST API. Same-origin: nginx proxies /api/* to
// the backend container, and `vite dev` proxies it to a local backend.

async function json(method, path) {
  const res = await fetch(path, { method });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const err = new Error((body && body.error) || `${method} ${path} -> ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

export const getSession = () => json('GET', '/api/session');
export const startSession = () => json('POST', '/api/session/start');
export const stopSession = () => json('POST', '/api/session/stop');
export const getConfig = () => json('GET', '/api/config');

export async function getReport() {
  try {
    return await json('GET', '/api/report');
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}
