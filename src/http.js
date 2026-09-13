// Simpel fetch-wrapper med timeout og eksponentiel backoff.
// Genforsoeger kun paa timeouts/netvaerksfejl og 5xx-svar (server-fejl) —
// aldrig paa 4xx, da et gentaget forkert kald bare vil fejle igen.

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchWithRetry(url, options = {}, settings = {}) {
  const { retries = 3, timeoutMs = 30000, backoffMs = 1000 } = settings;

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timer);

      const isServerError = response.status >= 500;
      if (isServerError && attempt < retries) {
        lastError = new Error(`${response.status} ${response.statusText}`);
        await sleep(backoffMs * 2 ** attempt);
        continue;
      }

      return response;
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
      if (attempt < retries) {
        await sleep(backoffMs * 2 ** attempt);
        continue;
      }
    }
  }

  throw new Error(`Kald til ${url} fejlede efter ${retries + 1} forsoeg: ${lastError?.message ?? lastError}`);
}
