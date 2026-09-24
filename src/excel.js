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

function isBlankCell(value) {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

function isMissingValue(value) {
  if (isBlankCell(value)) return true;

  // Klimakompasset writes this placeholder when a numerical E-nøgletal value
  // cannot be calculated. Bubble number fields must receive a number or no
  // value at all, never this display text.
  return typeof value === 'string' && /^\(?\s*ikke\s+angivet\s*\)?$/i.test(value.trim());
}

function rowStats(row) {
  const values = row.filter((value) => !isBlankCell(value));
  return {
    populated: values.length,
    text: values.filter((value) => typeof value === 'string').length,
  };
}

/**
 * Klimakompasset exports have a title and empty rows before the table. Rather
 * than relying on a fixed row number, select the wide, mostly textual row that
 * is immediately followed by data. This also keeps working if the export adds
 * or removes introductory rows.
 */
function findHeaderRowIndex(rows, sheetName) {
  const stats = rows.map(rowStats);
  const widestRow = Math.max(...stats.map((row) => row.populated));

  if (widestRow === 0) {
    throw new Error(`Fanen "${sheetName}" indeholder ingen celler.`);
  }

  // A title row usually has one or two populated cells. A table header is at
  // least half as wide as the widest row in the sheet.
  const minimumColumns = Math.max(2, Math.ceil(widestRow / 2));
  const candidates = stats
    .map((row, index) => ({ ...row, index }))
    .filter((row) => row.populated >= minimumColumns);

  if (candidates.length === 0) {
    throw new Error(`Kunne ikke finde en overskriftsrække i fanen "${sheetName}".`);
  }

  candidates.sort((a, b) => {
    const score = (candidate) => {
      const textRatio = candidate.text / candidate.populated;
      const nextRow = stats[candidate.index + 1];
      const isFollowedByData =
        nextRow && nextRow.populated >= Math.max(1, Math.ceil(candidate.populated / 2));

      // Text labels are a stronger header signal than data values. The small
      // bonus for a following populated row prevents a workbook title from
      // being mistaken for a header when it has the same width.
      return textRatio * 1000 + candidate.text * 10 + candidate.populated + (isFollowedByData ? 20 : 0);
    };

    return score(b) - score(a) || a.index - b.index;
  });

  return candidates[0].index;
}

function buildFields(headerRow) {
  const fields = [];
  const usedKeys = new Set();

  headerRow.forEach((rawKey, column) => {
    // Excel's used range can include formatted-but-empty columns. They are not
    // data fields and must never turn into Bubble fields such as "empty".
    if (isBlankCell(rawKey)) return;

    const originalKey = String(rawKey).trim();
    const baseKey = sanitizeKey(originalKey) || `felt_${column + 1}`;
    let key = baseKey;
    let suffix = 2;

    // Undgaar at to forskellige overskrifter (fx "CO2" og "CO₂") kolliderer
    // til samme noegle og overskriver hinanden.
    while (usedKeys.has(key)) {
      key = `${baseKey}_${suffix}`;
      suffix += 1;
    }

    usedKeys.add(key);
    const isParameterValue = /^parameter(?:\s+[23])?$/i.test(originalKey);
    fields.push({ column, originalKey, key, isParameterValue });
  });

  return fields;
}

function rowsToRecords(rows, fields) {
  return rows
    .filter((row) => row.some((value) => !isBlankCell(value)))
    .map((row) => {
      const record = {};

      for (const { column, key, isParameterValue } of fields) {
        const value = row[column];
        // Omitting missing values avoids overwriting Bubble defaults and is
        // safer than sending null or a display placeholder to typed fields.
        if (!isMissingValue(value)) {
          // Klimakompasset uses Parameter/Parameter 2/Parameter 3 for mixed
          // labels and numbers. Bubble fields have one fixed type, so preserve
          // both kinds of values as text in these flexible parameter fields.
          record[key] = isParameterValue ? String(value) : value;
        }
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
  const rows = XLSX.utils.sheet_to_json(worksheet, {
    header: 1,
    defval: null,
    blankrows: true,
  });
  const headerRowIndex = findHeaderRowIndex(rows, resolvedName);
  const fields = buildFields(rows[headerRowIndex]);

  if (fields.length === 0) {
    throw new Error(`Overskriftsrækken i fanen "${resolvedName}" indeholder ingen feltnavne.`);
  }

  const records = rowsToRecords(rows.slice(headerRowIndex + 1), fields);

  // Log felt-mapping én gang pr. koersel — goer det til at faa Bubble-felter
  // til at matche uden at aabne filen manuelt.
  if (records.length > 0) {
    const mapping = fields
      .map(({ originalKey, key }) => `${originalKey} -> ${key}`)
      .join(', ');
    console.log(
      `[excel] "${resolvedName}": ${records.length} raekker. Overskrifter på række ${headerRowIndex + 1}. Felter: ${mapping}`
    );
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
