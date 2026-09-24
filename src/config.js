// Laeser og validerer miljoevariabler. Fejler tidligt og tydeligt hvis noget
// paakraevet mangler, i stedet for at fejle uforstaaeligt midt i et API-kald.

function readArg(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function required(name) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`Miljoevariablen "${name}" mangler. Tjek repo-secrets / .env.`);
  }
  return value;
}

function optional(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function optionalInt(name, fallback) {
  const raw = optional(name, undefined);
  if (raw === undefined) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadConfig() {
  const dryRun = hasFlag('--dry-run') || optional('DRY_RUN', 'false').toLowerCase() === 'true';
  const localFile = readArg('--local-file');

  // I dry-run bliver Bubble aldrig reelt kaldt, saa Bubble-oplysningerne
  // behoever ikke vaere sat — det goer det muligt at teste parsing-logikken
  // (npm run test:local) helt uden nogen Bubble-opsaetning.
  const bubbleField = (name, placeholder) => (dryRun ? optional(name, placeholder) : required(name));

  return {
    // Bubble-forbindelsesoplysninger — paakraevede uden for dry-run.
    bubbleApiRoot: bubbleField('BUBBLE_API_ROOT', 'https://dry-run.invalid/api/1.1/obj').replace(/\/+$/, ''),
    bubbleApiToken: bubbleField('BUBBLE_API_TOKEN', 'dry-run-token'),

    // Data Type-navne i Bubble (skal matche praecist, case-sensitive).
    allePosterType: bubbleField('BUBBLE_ALLE_POSTER_TYPE', 'alle_poster'),
    eNoegletalType: bubbleField('BUBBLE_ENOEGLETAL_TYPE', 'e_noegletal'),

    // Input: enten en URL sendt fra Bubble (client_payload), eller en lokal
    // fil til test via --local-file.
    fileUrl: optional('FILE_URL', undefined),
    // Hver importeret række skal knyttes til den Bubble-bruger, -virksomhed
    // og det år, som platformen sendte med uploaden. I dry-run bruges
    // placeholders, så parsing kan testes lokalt.
    userId: dryRun ? optional('USER_ID', 'local-test-user') : required('USER_ID'),
    companyId: dryRun ? optional('COMPANY_ID', 'local-test-company') : required('COMPANY_ID'),
    yearId: dryRun ? optional('YEAR_ID', 'local-test-year') : required('YEAR_ID'),
    localFile,

    // Drift.
    dryRun,
    bulkChunkSize: Math.min(optionalInt('BULK_CHUNK_SIZE', 500), 1000), // Bubble's hard cap er 1000
    requestTimeoutMs: optionalInt('REQUEST_TIMEOUT_MS', 30000),
    maxRetries: optionalInt('MAX_RETRIES', 3),
  };
}
