// Entrypoint. Koeres af GitHub Actions ved repository_dispatch fra Bubble,
// eller lokalt til test (se README, "Test lokalt").
//
// Flow:
//   1. Hent .xlsx-filen (fra URL sendt af Bubble, eller en lokal fil)
//   2. Traek "Data (alle poster)" og "Data (E-nøgletal)" ud som JSON
//   3. Bulk-opret raekkerne i Bubble
//   4. (Valgfrit) Opdater en statuspost i Bubble, saa frontenden ved besked

import { readFile } from 'node:fs/promises';
import { loadConfig } from './config.js';
import { extractKlimakompasset } from './excel.js';
import { BubbleClient } from './bubble.js';
import { fetchWithRetry } from './http.js';

// Bubbles egne fil-URL'er starter ofte med "//" i stedet for "https://"
// (protocol-relative). fetch() forstaar ikke det format, saa vi retter det.
function normalizeFileUrl(url) {
  if (url.startsWith('//')) return `https:${url}`;
  return url;
}

async function loadFileBuffer(config) {
  if (config.localFile) {
    console.log(`[index] Laeser lokal fil: ${config.localFile}`);
    return readFile(config.localFile);
  }

  if (!config.fileUrl) {
    throw new Error(
      'Ingen fil at behandle: hverken FILE_URL (miljoevariabel) eller --local-file er sat.'
    );
  }

  const url = normalizeFileUrl(config.fileUrl);
  console.log(`[index] Henter fil fra: ${url}`);

  const response = await fetchWithRetry(
    url,
    {},
    { retries: config.maxRetries, timeoutMs: config.requestTimeoutMs }
  );

  if (!response.ok) {
    throw new Error(`Kunne ikke hente filen (HTTP ${response.status}) fra ${url}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

function summarizeBatch(label, result) {
  const parts = [`${result.created} oprettet`];
  if (result.failed > 0) parts.push(`${result.failed} fejlede`);
  console.log(`[index] ${label}: ${parts.join(', ')}`);
  if (result.errors.length > 0) {
    console.warn(`[index] ${label} — eksempler paa fejl: ${result.errors.join(' | ')}`);
  }
}

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    // Opsaetningsfejl (fx en glemt secret) — ingen Bubble-klient at rapportere
    // fejlen med endnu, saa den lander som en tydelig Actions-fejl i stedet.
    console.error(`[index] Konfigurationsfejl: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  const bubble = new BubbleClient({
    apiRoot: config.bubbleApiRoot,
    apiToken: config.bubbleApiToken,
    requestTimeoutMs: config.requestTimeoutMs,
    maxRetries: config.maxRetries,
    dryRun: config.dryRun,
  });

  try {
    const buffer = await loadFileBuffer(config);
    const { allePoster, eNoegletal } = extractKlimakompasset(buffer);

    const allePosterResult = await bubble.bulkCreate(
      config.allePosterType,
      allePoster,
      config.bulkChunkSize
    );
    summarizeBatch('Data (alle poster)', allePosterResult);

    const eNoegletalResult = await bubble.bulkCreate(
      config.eNoegletalType,
      eNoegletal,
      config.bulkChunkSize
    );
    summarizeBatch('Data (E-noegletal)', eNoegletalResult);

    const totalFailed = allePosterResult.failed + eNoegletalResult.failed;

    await bubble.updateStatus(config.statusType, config.uploadId, {
      status: totalFailed > 0 ? 'completed_with_errors' : 'completed',
      message:
        totalFailed > 0
          ? `${totalFailed} raekker blev afvist af Bubble. Se Actions-log for detaljer.`
          : 'Udtraek og import gennemfoert.',
      rows_alle_poster: allePosterResult.created,
      rows_e_noegletal: eNoegletalResult.created,
    });

    if (totalFailed > 0) {
      // Nogle raekker blev afvist (typisk Privacy Rules) — gør koerslen synligt
      // "fejlet" i Actions, selvom resten af dataene naaede frem.
      console.error(`[index] Foerdig med ${totalFailed} afviste raekker.`);
      process.exitCode = 1;
    } else {
      console.log('[index] Foerdig — alt blev importeret.');
    }
  } catch (err) {
    console.error(`[index] Fejl under koersel: ${err.message}`);

    await bubble.updateStatus(config.statusType, config.uploadId, {
      status: 'failed',
      message: err.message.slice(0, 500),
      rows_alle_poster: 0,
      rows_e_noegletal: 0,
    });

    process.exitCode = 1;
  }
}

main();
