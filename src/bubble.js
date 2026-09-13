// Klient til Bubbles Data API: bulk-opretter raekker.
//
// Bulk-endpointet (POST /obj/<type>/bulk) forventer text/plain med ét
// JSON-objekt pr. linje (ikke en JSON-array), og svarer selv med text/plain,
// ét JSON-objekt pr. linje med et "status"-felt. Det er vigtigt at parse
// svaret linje for linje: Bubble kan svare 200 OK, selvom nogle (eller alle)
// raekker reelt blev afvist af en Privacy Rule — det ses kun i svarteksten.
// Se: https://manual.bubble.io/core-resources/api/the-bubble-api/the-data-api/data-api-requests

import { fetchWithRetry } from './http.js';

const BUBBLE_BULK_HARD_LIMIT = 1000; // Haardt loft sat af Bubble, ikke konfigurerbart.

export class BubbleClient {
  constructor({ apiRoot, apiToken, requestTimeoutMs, maxRetries, dryRun }) {
    this.apiRoot = apiRoot;
    this.apiToken = apiToken;
    this.requestTimeoutMs = requestTimeoutMs;
    this.maxRetries = maxRetries;
    this.dryRun = dryRun;
  }

  _authHeaders() {
    return { Authorization: `Bearer ${this.apiToken}` };
  }

  /**
   * Opretter records i bulk i den angivne Data Type, i chunks.
   * @returns {{ created: number, failed: number, errors: string[] }}
   */
  async bulkCreate(typeName, records, chunkSize = 500) {
    const safeChunkSize = Math.min(chunkSize, BUBBLE_BULK_HARD_LIMIT);
    const summary = { created: 0, failed: 0, errors: [] };

    if (records.length === 0) return summary;

    for (let start = 0; start < records.length; start += safeChunkSize) {
      const chunk = records.slice(start, start + safeChunkSize);
      const batchLabel = `${typeName} batch ${Math.floor(start / safeChunkSize) + 1}`;

      if (this.dryRun) {
        console.log(`[bubble] (dry-run) ville bulk-oprette ${chunk.length} raekker i "${typeName}"`);
        summary.created += chunk.length;
        continue;
      }

      const body = chunk.map((record) => JSON.stringify(record)).join('\n');

      // eslint-disable-next-line no-await-in-loop -- chunks skal koere i raekkefoelge, ikke parallelt, for at holde belastningen paa Bubble forudsigelig
      const response = await fetchWithRetry(
        `${this.apiRoot}/${typeName}/bulk`,
        {
          method: 'POST',
          headers: { ...this._authHeaders(), 'Content-Type': 'text/plain' },
          body,
        },
        { retries: this.maxRetries, timeoutMs: this.requestTimeoutMs }
      );

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`${batchLabel} fejlede med HTTP ${response.status}: ${text.slice(0, 500)}`);
      }

      // eslint-disable-next-line no-await-in-loop
      const text = await response.text();
      const lines = text.split('\n').filter((line) => line.trim().length > 0);

      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.status === 'success') {
            summary.created += 1;
          } else {
            summary.failed += 1;
            if (summary.errors.length < 10) {
              summary.errors.push(parsed.message || JSON.stringify(parsed));
            }
          }
        } catch {
          // Uventet linjeformat — taell den som fejlet, men vaelt ikke hele koerslen.
          summary.failed += 1;
        }
      }
    }

    return summary;
  }
}
