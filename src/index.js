// Entrypoint. Koeres af GitHub Actions ved repository_dispatch fra Bubble,
// eller lokalt til test (se README, "Test lokalt").
//
// Flow:
//   1. Hent .xlsx-filen (fra URL sendt af Bubble, eller en lokal fil)
//   2. Traek "Data (alle poster)" og "Data (E-nøgletal)" ud som JSON
//   3. Knyt rækkerne til den uploadende bruger, virksomhed og år
//   4. Bulk-opret raekkerne i Bubble

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

function assignRelations(records, userId, companyId, yearId) {
  return records.map((record) => ({
    ...record,
    user: userId,
    company: companyId,
    year: yearId,
  }));
}

async function main() {
  const runStartedAt = Date.now();
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
    const fileStartedAt = Date.now();
    const buffer = await loadFileBuffer(config);
    console.log(`[index] Fil hentet paa ${((Date.now() - fileStartedAt) / 1000).toFixed(1)} s.`);

    const parseStartedAt = Date.now();
    const { allePoster, eNoegletal } = extractKlimakompasset(buffer);
    console.log(`[index] Excel parset paa ${((Date.now() - parseStartedAt) / 1000).toFixed(1)} s.`);
    const allePosterWithRelations = assignRelations(
      allePoster,
      config.userId,
      config.companyId,
      config.yearId
    );
    const eNoegletalWithRelations = assignRelations(
      eNoegletal,
      config.userId,
      config.companyId,
      config.yearId
    );

    // Begge datatyper er uafhaengige og sendes derfor til Bubble samtidigt.
    const bubbleStartedAt = Date.now();
    const [allePosterOutcome, eNoegletalOutcome] = await Promise.allSettled([
      bubble.bulkCreate(config.allePosterType, allePosterWithRelations, config.bulkChunkSize),
      bubble.bulkCreate(config.eNoegletalType, eNoegletalWithRelations, config.bulkChunkSize),
    ]);
    console.log(`[index] Bubble-kald faerdige paa ${((Date.now() - bubbleStartedAt) / 1000).toFixed(1)} s.`);

    let hasRequestFailure = false;
    let totalFailed = 0;
    for (const [label, outcome] of [
      ['Data (alle poster)', allePosterOutcome],
      ['Data (E-noegletal)', eNoegletalOutcome],
    ]) {
      if (outcome.status === 'fulfilled') {
        summarizeBatch(label, outcome.value);
        totalFailed += outcome.value.failed;
      } else {
        console.error(`[index] ${label} — Bubble-kald fejlede: ${outcome.reason.message}`);
        hasRequestFailure = true;
      }
    }

    if (totalFailed > 0 || hasRequestFailure) {
      // Nogle raekker blev afvist (typisk Privacy Rules) — gør koerslen synligt
      // "fejlet" i Actions, selvom resten af dataene naaede frem.
      if (totalFailed > 0) console.error(`[index] Foerdig med ${totalFailed} afviste raekker.`);
      process.exitCode = 1;
    } else {
      console.log('[index] Foerdig — alt blev importeret.');
    }
    console.log(`[index] Samlet koerselstid: ${((Date.now() - runStartedAt) / 1000).toFixed(1)} s.`);
  } catch (err) {
    console.error(
      `[index] Fejl under koersel efter ${((Date.now() - runStartedAt) / 1000).toFixed(1)} s: ${err.message}`
    );
    process.exitCode = 1;
  }
}

main();
