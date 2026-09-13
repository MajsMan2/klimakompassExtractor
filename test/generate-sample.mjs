// Genererer en syntetisk test-xlsx med samme fane-navne som den rigtige
// Klimakompasset-fil, saa parsing-logikken kan afproeves uden en rigtig fil.
// Koer: npm run test:generate-sample

import * as XLSX from 'xlsx';
import { writeFileSync } from 'node:fs';

const allePosterRows = [
  {
    Dato: new Date('2026-01-15'),
    Kategori: 'Elforbrug',
    Beskrivelse: 'Elforbrug kontor Q1',
    'Mængde': 1200,
    Enhed: 'kWh',
    'CO2e (kg)': 156.4,
  },
];

const eNoegletalRows = Array.from({ length: 26 }, (_, i) => ({
  'Nøgletal-ID': `E${i + 1}`,
  Navn: `Eksempel-nøgletal ${i + 1}`,
  'Værdi': Math.round(Math.random() * 1000) / 10,
  Enhed: i % 2 === 0 ? 'ton CO2e' : 'kr.',
}));

const workbook = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(
  workbook,
  XLSX.utils.json_to_sheet(allePosterRows),
  'Data (alle poster)'
);
XLSX.utils.book_append_sheet(
  workbook,
  XLSX.utils.json_to_sheet(eNoegletalRows),
  'Data (E-nøgletal)'
);
// En ekstra, urelateret fane — for at bekraefte at vi kun laeser de to rigtige.
XLSX.utils.book_append_sheet(
  workbook,
  XLSX.utils.aoa_to_sheet([['Note'], ['Denne fane skal ignoreres']]),
  'Vejledning'
);

const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
writeFileSync(new URL('./sample.xlsx', import.meta.url), buffer);

console.log('Skrev test/sample.xlsx');
