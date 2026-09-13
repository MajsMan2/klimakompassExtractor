// Traekker de to relevante faner ud af Klimakompasset-filen og konverterer
// hver raekke til et JSON-objekt med rensede noegler (klar til Bubble).

import * as XLSX from 'xlsx';

export const SHEET_NAMES = {
  allePoster: 'Data (alle poster)',
  eNoegletal: 'Data (E-nøgletal)',
};

// Finder fanen ved praecist navn foerst; falder tilbage til en case-/whitespace-
// ufoelsom sammenligning, saa smaa variationer i filen (fx et trailing mellemrum)
// ikke vaelter hele koerslen.
function findSheetName(workbook, targetName) {
  if (workbook.Sheets[targetName]) return targetName;

  const normalizedTarget = targetName.trim().toLowerCase();
  return (
    workbook.SheetNames.find((name) => name.trim().toLowerCase() === normalizedTarget) ?? null
  );
}

// Bubble-, JSON- og API-venlig noegle: aeoeaa -> ae/oe/aa, lowercase, kun [a-z0-9_].
export function sanitizeKey(rawKey) {
  return String(rawKey)
    .trim()
    .toLowerCase()
    .replace(/æ/g, 'ae')
    .replace(/ø/g, 'oe')
    .replace(/å/g, 'aa')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function rowsToRecords(rawRows) {
  return rawRows.map((row) => {
    const record = {};
    const usedKeys = new Set();

    for (const [rawKey, value] of Object.entries(row)) {
      const baseKey = sanitizeKey(rawKey) || 'felt';
      let finalKey = baseKey;
      let suffix = 2;
      // Undgaar at to forskellige overskrifter (fx "CO2" og "CO₂") kolliderer
      // til samme noegle og overskriver hinanden.
      while (usedKeys.has(finalKey)) {
        finalKey = `${baseKey}_${suffix}`;
        suffix += 1;
      }
      usedKeys.add(finalKey);
      record[finalKey] = value;
    }

    return record;
  });
}

function extractSheet(workbook, targetSheetName) {
  const resolvedName = findSheetName(workbook, targetSheetName);
  if (!resolvedName) {
    throw new Error(
      `Fanen "${targetSheetName}" blev ikke fundet i filen. Faner i filen: ${workbook.SheetNames.join(', ')}`
    );
  }

  const worksheet = workbook.Sheets[resolvedName];
  const rawRows = XLSX.utils.sheet_to_json(worksheet, { defval: null });
  const records = rowsToRecords(rawRows);

  // Log felt-mapping én gang pr. koersel — goer det til at faa Bubble-felter
  // til at matche uden at aabne filen manuelt.
  if (records.length > 0) {
    const mapping = Object.keys(rawRows[0])
      .map((raw) => `${raw} -> ${sanitizeKey(raw)}`)
      .join(', ');
    console.log(`[excel] "${resolvedName}": ${records.length} raekker. Felter: ${mapping}`);
  } else {
    console.warn(`[excel] "${resolvedName}" blev fundet, men indeholder 0 datarækker.`);
  }

  return records;
}

/**
 * @param {Buffer} buffer - raw indhold af .xlsx-filen
 * @returns {{ allePoster: object[], eNoegletal: object[] }}
 */
export function extractKlimakompasset(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });

  return {
    allePoster: extractSheet(workbook, SHEET_NAMES.allePoster),
    eNoegletal: extractSheet(workbook, SHEET_NAMES.eNoegletal),
  };
}
