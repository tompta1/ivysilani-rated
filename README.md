# Filmy na iVysílání

Statický frontend pro GitHub Pages a backend pro Vercel. Frontend zobrazuje filmy aktuálně dostupné v kategorii `Filmy` na iVysílání a bere kurátorovaný dataset z Neon databáze přes Vercel API.

Produkční backend:

- `https://ivysilani-rated.vercel.app`
- health check: `https://ivysilani-rated.vercel.app/api/health`

## Architektura

- GitHub Pages: hostuje statický frontend z `src/`
- Vercel: hostuje API endpointy
- Neon: ukládá roční „source core dataset“

Frontend volá dva endpointy:

- `GET /api/ct-movies`: denně cacheovaný katalog filmů z ČT s živým fallbackem
- `GET /api/source-core-dataset`: poslední dataset uložený v Neon
- `GET /api/health`: jednoduchý health check backendu a dostupnosti datasetu

Klient pak zobrazí jen tituly, které jsou aktuálně dostupné na iVysílání.

## Zdrojový dataset

Dataset obsahuje:

- normalizované názvy a roky
- hodnocení a odkazy na Kinobox a ČSFD
- vážené skóre
- mapu miniatur z detailových stránek iVysílání

Dataset se už neuchovává v repozitáři. Repo obsahuje jen skripty, které ho umí jednou ročně znovu vytvořit a nahrát do Neon.

## Denní cache katalogu ČT

Katalog `Filmy` z iVysílání se mění častěji než roční ranking dataset, takže je uložený zvlášť:

- Neon tabulka `ct_catalogue_snapshots`
- denní refresh přes GitHub Actions
- `GET /api/ct-movies` čte nejdřív Neon snapshot
- pokud snapshot chybí nebo je starší než 36 hodin, endpoint spadne zpět na živý dotaz do ČT API

Lokální ruční refresh do Neon:

```bash
npm run refresh:ct-catalogue-cache
```

## Lokální vývoj

Vytvoř `.env` podle [`.env.example`](./.env.example).

```bash
npm install
npm run dev
```

Produkční build frontendu:

```bash
npm run build
npm run preview
```

## Neon setup

Nejdřív připrav tabulku:

```bash
npm run setup:neon
```

SQL schéma je v [db/source-core-dataset.sql](./db/source-core-dataset.sql).

## ETL a upload do Neon

Jednorázový lokální běh celé pipeline:

```bash
npm run refresh:source-core-dataset -- --output-file /tmp/source-core-dataset.json
npm run push:source-core-dataset:neon -- --dataset-file /tmp/source-core-dataset.json
```

Pipeline dělá toto:

1. přes Playwright stáhne veřejné žebříčky do dočasné složky mimo repozitář
2. extrahuje kandidátní data
3. vyrobí vážený dataset
4. dohledá miniatury z iVysílání
5. nahraje výsledný dataset do Neon
6. dočasné raw snapshoty smaže

## GitHub Actions

Projekt obsahuje tři workflow:

- [`.github/workflows/deploy-pages.yml`](./.github/workflows/deploy-pages.yml)
  build a publish frontendu na GitHub Pages
- [`.github/workflows/refresh-ct-catalogue-cache.yml`](./.github/workflows/refresh-ct-catalogue-cache.yml)
  denní refresh katalogu `Filmy` z ČT do Neon
- [`.github/workflows/refresh-source-core-dataset.yml`](./.github/workflows/refresh-source-core-dataset.yml)
  roční ETL běh a upload datasetu do Neon

## Potřebné proměnné a secrets

GitHub Pages build:

- repo variable `VITE_API_BASE_URL`
  příklad: `https://ivysilani-rated.vercel.app`

Vercel backend, denní cache a roční ETL:

- `DATABASE_URL` nebo `NEON_DATABASE_URL`

GitHub Actions secret:

- `DATABASE_URL`

## Health endpoint

Backend vystavuje:

```text
GET /api/health
```

Vrací základní stav API a informaci, jestli je v Neon aktuálně dostupný dataset a poslední CT snapshot.

Příklad odpovědi:

```json
{
  "ok": true,
  "service": "ivysilani-rated-api",
  "checkedAt": "2026-04-06T19:53:01.116Z",
  "dataset": {
    "present": true,
    "generatedAt": "2026-04-06T19:46:22.396Z",
    "itemCount": 1010,
    "posterCount": 21
  },
  "ctCatalogue": {
    "present": true,
    "snapshotDate": "2026-04-06",
    "fetchedAt": "2026-04-06T20:00:00.000Z",
    "itemCount": 953,
    "totalCount": 953
  }
}
```

## Deploy checklist

1. Nastav ve Vercelu `DATABASE_URL` pro `production`, `preview` a `development`.
2. Nastav v GitHub repo variable `VITE_API_BASE_URL`.
3. Nastav v GitHub repo secret `DATABASE_URL`.
4. Jednou spusť `npm run setup:neon`.
5. Pushni repozitář do větve `main`.
6. Zapni GitHub Pages z GitHub Actions.

## Poznámka k datům

Automatizace závisí na veřejně dostupných stránkách třetích stran. Pokud změní HTML nebo ochrany proti botům, bude potřeba upravit scraper skripty.
