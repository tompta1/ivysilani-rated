import './style.css'
import { normalizeTitle, yearToNumber } from '../lib/title-match'

type CtMovie = {
  id: string
  slug: string
  title: string
  year: string | null
  shortDescription: string | null
  url: string
}

type CtMoviesResponse = {
  category: {
    id: string
    name: string
  }
  fetchedAt: string
  items: CtMovie[]
  itemCount: number
  totalCount: number
}

type RankedMatch = {
  kinoboxRank: number | null
  title: string
  year: number
  kinoboxRating: number | null
  kinoboxUrl: string | null
  csfdRating: number | null
  csfdBestRank: number | null
  csfdUrl: string | null
  compositeScore: number | null
  matchType: 'title+year' | 'alias+year' | 'title+year±1' | 'alias+year±1'
  ct: CtMovie
}

type WeightedSeedItem = {
  title: string
  year: number | null
  aliases?: readonly string[]
  kinoboxRating: number | null
  kinoboxRank: number | null
  kinoboxUrl: string | null
  csfdRating: number | null
  csfdBestRank: number | null
  csfdUrl: string | null
  compositeScore: number | null
}

type WeightedSeedPayload = {
  itemCount: number
  items: WeightedSeedItem[]
}

type CtPosterItem = {
  slug: string
  posterUrl: string
}

type EraFilter = {
  key: string
  label: string
  start: number
  end: number
}

type SourceCoreDataset = {
  generatedAt: string
  itemCount: number
  posterCount: number
  items: WeightedSeedItem[]
  posters: CtPosterItem[]
}

const app = document.querySelector<HTMLDivElement>('#app')

if (!app) {
  throw new Error('Kořen aplikace nebyl nalezen.')
}

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '')
const initialWeightedSeed: WeightedSeedPayload = {
  itemCount: 0,
  items: [],
}
let weightedSeed = initialWeightedSeed
let ctPosterBySlug = new Map<string, string>()

const currentYear = new Date().getFullYear()
let availableYears: number[] = []
let eraFilters: EraFilter[] = []
let activeEraKey = 'all'

function rebuildEraFilters(): void {
  const recentEraStart = currentYear - 9
  const decadeStarts = Array.from(new Set(availableYears.map((year) => Math.floor(year / 10) * 10))).sort(
    (left, right) => right - left,
  )
  const oldestYear = availableYears[0] ?? null

  eraFilters = [
    {
      key: 'all',
      label: 'Vše',
      start: Number.NEGATIVE_INFINITY,
      end: Number.POSITIVE_INFINITY,
    },
    {
      key: 'recent-10',
      label: 'Posledních 10 let',
      start: recentEraStart,
      end: currentYear,
    },
    ...decadeStarts
      .filter((decade) => decade >= 1980)
      .map((decade) => ({
        key: String(decade),
        label: `${String(decade).slice(2, 4)}. léta`,
        start: decade,
        end: decade + 9,
      })),
    ...(oldestYear !== null && oldestYear < 1980
      ? [
          {
            key: 'oldies',
            label: 'Starší',
            start: oldestYear,
            end: 1979,
          },
        ]
      : []),
  ]
}

function hydrateSourceCoreDataset(dataset: SourceCoreDataset): void {
  weightedSeed = {
    itemCount: dataset.itemCount,
    items: dataset.items,
  }
  ctPosterBySlug = new Map(dataset.posters.map((item) => [item.slug, item.posterUrl]))
  availableYears = Array.from(
    new Set(weightedSeed.items.map((item) => item.year).filter((year): year is number => year !== null)),
  ).sort((left, right) => left - right)
  rebuildEraFilters()
}

rebuildEraFilters()

app.innerHTML = `
  <div class="page-shell">
    <header class="page-header">
      <h1>Nejlepší filmy na iVysílání</h1>
      <p class="page-description">
        Aktuálně dostupné filmy z iVysílání řazené podle kombinace hodnocení z Kinoboxu a ČSFD.
      </p>
    </header>

    <section class="filters-panel" aria-label="Filtr období">
      <div id="era-toggles" class="toggle-row" role="group" aria-label="Výběr období"></div>
    </section>

    <main class="leaderboard-shell">
      <div id="leaderboard" class="leaderboard" aria-live="polite"></div>
    </main>
  </div>
`

const leaderboard = document.querySelector<HTMLDivElement>('#leaderboard')
const eraToggles = document.querySelector<HTMLDivElement>('#era-toggles')

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function yearsWithinTolerance(left: string | null, right: number, tolerance = 1): boolean {
  const parsedLeft = yearToNumber(left)

  if (parsedLeft === null) {
    return false
  }

  return Math.abs(parsedLeft - right) <= tolerance
}

function isSeedWithinActiveEra(seed: WeightedSeedItem): boolean {
  if (seed.year === null) {
    return false
  }

  const activeEra = eraFilters.find((item) => item.key === activeEraKey)

  if (!activeEra) {
    return true
  }

  return seed.year >= activeEra.start && seed.year <= activeEra.end
}

function findCtMatch(seed: WeightedSeedItem, ctMovies: readonly CtMovie[]): RankedMatch | null {
  if (seed.year === null) {
    return null
  }

  const seedYear = seed.year
  const candidateTitles = [seed.title, ...(seed.aliases ?? [])]

  for (const candidateTitle of candidateTitles) {
    const exact = ctMovies.find(
      (movie) =>
        normalizeTitle(movie.title) === normalizeTitle(candidateTitle) &&
        yearToNumber(movie.year) === seedYear,
    )

    if (exact) {
      return {
        kinoboxRank: seed.kinoboxRank,
        title: seed.title,
        year: seedYear,
        kinoboxRating: seed.kinoboxRating,
        kinoboxUrl: seed.kinoboxUrl,
        csfdRating: seed.csfdRating,
        csfdBestRank: seed.csfdBestRank,
        csfdUrl: seed.csfdUrl,
        compositeScore: seed.compositeScore,
        matchType: candidateTitle === seed.title ? 'title+year' : 'alias+year',
        ct: exact,
      }
    }
  }

  for (const candidateTitle of candidateTitles) {
    const nearYear = ctMovies.find(
      (movie) =>
        normalizeTitle(movie.title) === normalizeTitle(candidateTitle) &&
        yearsWithinTolerance(movie.year, seedYear),
    )

    if (nearYear) {
      return {
        kinoboxRank: seed.kinoboxRank,
        title: seed.title,
        year: seedYear,
        kinoboxRating: seed.kinoboxRating,
        kinoboxUrl: seed.kinoboxUrl,
        csfdRating: seed.csfdRating,
        csfdBestRank: seed.csfdBestRank,
        csfdUrl: seed.csfdUrl,
        compositeScore: seed.compositeScore,
        matchType: candidateTitle === seed.title ? 'title+year±1' : 'alias+year±1',
        ct: nearYear,
      }
    }
  }

  return null
}

function renderLeaderboardItem(item: RankedMatch, displayRank: number): string {
  const score = item.compositeScore === null ? 'n/a' : `${Math.round(item.compositeScore)}%`
  const description =
    item.ct.shortDescription === null ? 'Živá shoda z katalogu ČT.' : escapeHtml(item.ct.shortDescription)
  const posterUrl = ctPosterBySlug.get(item.ct.slug) ?? null
  const sourcePills = [
    item.kinoboxRating === null ? null : `<span class="source-pill">Kinobox ${item.kinoboxRating}%</span>`,
    item.csfdRating === null ? null : `<span class="source-pill">ČSFD ${item.csfdRating}%</span>`,
  ]
    .filter((value): value is string => value !== null)
    .join('')
  const rankMeta = [
    item.kinoboxRank === null ? null : `Kinobox #${item.kinoboxRank}`,
    item.csfdBestRank === null ? null : `ČSFD #${item.csfdBestRank}`,
  ]
    .filter((value): value is string => value !== null)
    .join(' • ')

  return `
    <article class="leader-row">
      <div class="rank-col">
        <span class="rank-number">${displayRank}</span>
      </div>
      <div class="poster-col" aria-hidden="true">
        ${
          posterUrl === null
            ? `<div class="poster-placeholder">${escapeHtml(item.title.slice(0, 1))}</div>`
            : `<img class="poster-image" src="${escapeHtml(posterUrl)}" alt="Plakát: ${escapeHtml(item.title)}" loading="lazy" decoding="async" referrerpolicy="no-referrer" />`
        }
      </div>
      <div class="title-col">
        <div class="title-line">
          <h3>${escapeHtml(item.title)}</h3>
          <span class="year-pill">${item.year}</span>
        </div>
        <p class="match-meta">${escapeHtml(rankMeta)}${item.ct.year === null ? '' : `${rankMeta.length === 0 ? '' : ' • '}ČT ${escapeHtml(item.ct.year)}`}</p>
        <div class="source-row">${sourcePills}</div>
        <p class="summary">${description}</p>
        <div class="action-row">
          <a class="cta-link" href="${item.ct.url}" target="_blank" rel="noreferrer">Otevřít na iVysílání</a>
          ${
            item.kinoboxUrl === null
              ? ''
              : `<a class="ghost-link" href="${item.kinoboxUrl}" target="_blank" rel="noreferrer">Kinobox</a>`
          }
          ${
            item.csfdUrl === null
              ? ''
              : `<a class="ghost-link" href="${item.csfdUrl}" target="_blank" rel="noreferrer">ČSFD</a>`
          }
        </div>
      </div>
      <div class="score-col">
        <span class="score-value">${score}</span>
        <span class="score-label">vážené skóre</span>
      </div>
    </article>
  `
}

function renderEraToggles(): void {
  if (!eraToggles) {
    return
  }

  eraToggles.innerHTML = eraFilters
    .map(
      (era) => `
        <button
          type="button"
          class="toggle-chip${activeEraKey === era.key ? ' is-active' : ''}"
          data-era-key="${era.key}"
          aria-pressed="${activeEraKey === era.key ? 'true' : 'false'}"
        >
          ${era.label}
        </button>
      `,
    )
    .join('')
}

function renderMatches(payload: CtMoviesResponse): void {
  const filteredSeed = weightedSeed.items.filter((seed) => isSeedWithinActiveEra(seed))
  const matches = filteredSeed
    .map((seed) => findCtMatch(seed, payload.items))
    .filter((item): item is RankedMatch => item !== null)
    .sort((left, right) => {
      const leftScore = left.compositeScore ?? -1
      const rightScore = right.compositeScore ?? -1

      if (rightScore !== leftScore) {
        return rightScore - leftScore
      }

      if (left.kinoboxRank !== right.kinoboxRank) {
        return (left.kinoboxRank ?? Number.POSITIVE_INFINITY) - (right.kinoboxRank ?? Number.POSITIVE_INFINITY)
      }

      return left.title.localeCompare(right.title, 'cs')
    })

  if (leaderboard) {
    leaderboard.innerHTML =
      matches.length === 0
        ? '<p class="empty-state">Pro vybrané období teď není k dispozici žádná odpovídající položka.</p>'
        : matches.map((item, index) => renderLeaderboardItem(item, index + 1)).join('')
  }
}

function getApiUrl(pathname: string): string {
  return apiBaseUrl.length === 0 ? pathname : `${apiBaseUrl}${pathname}`
}

async function loadLeaderboard(): Promise<void> {
  if (leaderboard) {
    leaderboard.innerHTML = '<p class="empty-state">Načítám katalog ČT a zdrojová data…</p>'
  }

  try {
    const [ctResponse, sourceResponse] = await Promise.all([
      fetch(getApiUrl('/api/ct-movies')),
      fetch(getApiUrl('/api/source-core-dataset')),
    ])

    if (!ctResponse.ok) {
      throw new Error(`Katalog ČT odpověděl ${ctResponse.status}`)
    }

    if (!sourceResponse.ok) {
      throw new Error(`Zdrojová data odpověděla ${sourceResponse.status}`)
    }

    const payload = (await ctResponse.json()) as CtMoviesResponse
    const dataset = (await sourceResponse.json()) as SourceCoreDataset

    hydrateSourceCoreDataset(dataset)
    renderEraToggles()
    renderMatches(payload)

    eraToggles?.addEventListener('click', (event) => {
      const target = event.target

      if (!(target instanceof HTMLButtonElement)) {
        return
      }

      const eraKey = target.dataset.eraKey

      if (!eraKey) {
        return
      }

      activeEraKey = eraKey
      renderEraToggles()
      renderMatches(payload)
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Neznámá chyba'

    if (leaderboard) {
      leaderboard.innerHTML = `<p class="empty-state">Načtení žebříčku selhalo: ${escapeHtml(message)}</p>`
    }
  }
}

void loadLeaderboard()
