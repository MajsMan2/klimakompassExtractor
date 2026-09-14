# Klimakompasset extractor

Traekker data ud af de to faner **"Data (alle poster)"** og **"Data (E-nøgletal)"**
i en kundes uploadede Klimakompasset-excelfil, og pusher dem som JSON ind i to
Bubble Data Types via Bubbles Data API.

Samme moenster som resten af pipelinen: **ingen server, ingen hosting** — kun
GitHub Actions (gratis Actions-minutter) og Bubble.

## Flow

```
Kunde uploader .xlsx i Bubble
        │
        ▼
Bubble-workflow:
  1. API Connector-kald → POST /repos/OWNER/REPO/dispatches (GitHub)
        │  { event_type: "extract_klimakompasset",
        │    client_payload: { file_url, user_id, company_id } }
        ▼
GitHub Actions (repository_dispatch)
  1. Henter .xlsx fra file_url
  2. Parser "Data (alle poster)" og "Data (E-nøgletal)" → JSON
  3. Knytter hver række til uploadende Bubble-bruger og -virksomhed
  4. Bulk-opretter raekkerne i Bubble (chunket, med retries)
        │
        ▼
Bubble Data Types opdateret — kunden kan filtrere/vise dataene
```

GitHub svarer med det samme paa dispatch-kaldet (bare "modtaget") — selve
arbejdet sker i baggrunden i Actions. Regn med nogle faa sekunder til et
minuts tid foer raekkerne dukker op i Bubble, afhaengig af filstoerrelse.

## Mappestruktur

```
.github/workflows/extract-and-push.yml   Selve GitHub Actions-workflowet
src/
  index.js       Entrypoint — orkestrerer hele flowet
  excel.js       Finder og parser de to faner, renser feltnavne
  bubble.js      Bubble Data API-klient (bulk create)
  http.js        fetch med timeout + eksponentiel backoff
  config.js      Laeser og validerer miljoevariabler/secrets
test/
  generate-sample.mjs   Genererer en syntetisk testfil (samme fanenavne)
```

## Opsætning

### 1. Push koden til et GitHub-repo

```bash
git init   # hvis du ikke allerede har koert det
git add .
git commit -m "Klimakompasset extractor"
git remote add origin https://github.com/MajsMan2/klimakompassExtractor.git
git push -u origin main
```

### 2. Opret et GitHub personal access token

Bubble skal kunne trigge din workflow, og det kraever et token — den
indbyggede `GITHUB_TOKEN` kan ikke bruges til det udefra.

Lav et **fine-grained personal access token** (github.com → Settings →
Developer settings → Personal access tokens → Fine-grained tokens),
scopet til kun dette repo, med:

- **Contents: Read and write**
- **Metadata: Read-only** (vaelges automatisk)

Gem tokenet et sikkert sted — det skal bruges i Bubbles API Connector, ikke
som et repo-secret.

### 3. Saet repo-secrets

GitHub repo → Settings → Secrets and variables → Actions → New repository secret:

| Secret | Beskrivelse |
|---|---|
| `BUBBLE_API_ROOT` | Fx `https://dit-app.bubbleapps.io/api/1.1/obj` (brug `/version-test/api/1.1/obj` for at skrive til test-versionen i stedet for live) |
| `BUBBLE_API_TOKEN` | Din Bubble Private Key (Settings → API i Bubble-editoren) |
| `BUBBLE_ALLE_POSTER_TYPE` | API-navnet paa Data Type'n for "alle poster" |
| `BUBBLE_ENOEGLETAL_TYPE` | API-navnet paa Data Type'n for "E-nøgletal" |

> **Tip:** Data Type'ns API-navn er ikke altid det samme som visningsnavnet i
> editoren. Tjek det praecise navn under Bubble → Settings → API → Data API-fanen.

I Bubble skal hver Data Type desuden have **"Create via API"** krydset af
under dens Privacy Rules — ellers svarer Bubble med 401/afviser stille og
roligt raekkerne, selvom bulk-kaldet ser ud til at lykkes.

### 4. Saet API Connector-kaldet op i Bubble

Opret ét nyt API Connector-kald, der rammer GitHub direkte (Bubble kalder
GitHub, ikke omvendt):

- **Method:** `POST`
- **URL:** `https://api.github.com/repos/<owner>/<repo>/dispatches`
- **Headers:**
  - `Accept: application/vnd.github+json`
  - `Authorization: Bearer <PAT fra trin 2>`
  - `X-GitHub-Api-Version: 2022-11-28`
  - `Content-Type: application/json`
- **Body (raw JSON):**
  ```json
  {
    "event_type": "extract_klimakompasset",
    "client_payload": {
      "file_url": "<file_url>",
      "user_id": "<user_id>",
      "company_id": "<company_id>"
    }
  }
  ```

Kald det fra den workflow, der koerer naar en kunde uploader filen.

> `file_url` skal sættes til den uploadede fils URL, `user_id` til
> `Current User's unique id`, og `company_id` til virksomhedens unique id.
> `client_payload` maa maks. indeholde 10 felter paa oeverste niveau.

## Test lokalt

```bash
npm install
cp .env.example .env    # udfyld hvis du vil teste et rigtigt Bubble-kald

# Genererer en syntetisk testfil med de rigtige fanenavne og koerer
# hele flowet i dry-run (rører IKKE Bubble, viser bare hvad der ville ske):
npm run test:local

# Mod din egen fil, stadig uden at kalde Bubble:
node src/index.js --local-file /sti/til/din-fil.xlsx --dry-run

# Naar du er klar til at teste et rigtigt (ikke-dry-run) kald lokalt:
node --env-file=.env src/index.js --local-file /sti/til/din-fil.xlsx
```

## Feltnavne

Excel-overskrifter renses til Bubble-/JSON-venlige noegler, saa I slipper
for danske specialtegn i API-kaldene:

- Sænkes til lowercase
- `æ → ae`, `ø → oe`, `å → aa`
- Alt andet end bogstaver/tal bliver til `_` (mellemrum, parenteser, bindestreg …)

Eksempel: `"CO2e (kg)"` → `co2e_kg`, `"Nøgletal-ID"` → `noegletal_id`.

Den fulde mapping fra original-overskrift til renset noegle logges ved hver
koersel (se Actions-loggen), saa I altid kan se præcis hvilke felter der
skal oprettes i Bubble. To overskrifter der rammer samme renset noegle i
samme raekke faar automatisk et `_2`, `_3` … suffiks, saa data aldrig
overskriver hinanden stille og roligt.

## Bruger- og virksomhedsrelation

Opret felterne `user` og `company` på begge import-Data Types. Sæt `user` til
typen **User** og `company` til den Data Type, der repræsenterer jeres
virksomhed. Importen sætter dem til henholdsvis `user_id` og `company_id`, som
Bubble-workflowet sender med filens URL. Dermed kan Privacy Rules fx lade
brugere se data, hvor `This thing's user is Current User`, eller afgrænse data
til den aktuelle virksomhed.

## Graenser og skalering

- Bubbles bulk-endpoint tager maks. **1000 objekter pr. kald** — scriptet
  chunker automatisk (500 ad gangen som standard, konfigurerbart via
  `BULK_CHUNK_SIZE`, men aldrig over 1000).
- Bubble kan svare 200 OK selvom nogle raekker reelt blev afvist (typisk en
  manglende Privacy Rule) — scriptet laeser derfor svaret linje for linje og
  taeller faktiske succeser/fejl, ikke bare HTTP-statussen.
- Netvaerkskald (bade filhentning og Bubble-kald) forsoeges automatisk igen
  ved timeout eller 5xx-fejl, med eksponentiel backoff (`MAX_RETRIES`,
  standard 3 forsoeg).
- To dispatches med samme `file_url` koerer ikke samtidigt (se `concurrency`
  i workflow-filen). Det reducerer, men fjerner ikke helt, risikoen for
  dubletter hvis Bubble sender samme trigger igen efter den foerste koersel.

## Fejlhaandtering

- Mangler en fane (fx pga. en aeldre skabelon-version), eller en paakraevet
  secret, stopper koerslen med en tydelig fejlbesked i Actions-loggen.
- Alt logges til Actions' egen log (repo → Actions-fanen → vælg koerslen),
  inkl. antal raekker fundet pr. fane og feltmapping.
