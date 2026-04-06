import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { chromium } from 'playwright'
import { parseArgs } from './lib/args.mjs'
import { fetchAllCtMovies } from './lib/ct-catalogue.mjs'
import { normalizeTitle, yearToNumber } from './lib/title-match.mjs'

const options = parseArgs(process.argv.slice(2))
const weightedSeedPath =
  typeof options['weighted-file'] === 'string'
    ? path.resolve(options['weighted-file'])
    : path.join(process.cwd(), 'data', 'generated', 'weighted-seed-2026-04-06.json')
const outputPath =
  typeof options['output-file'] === 'string'
    ? path.resolve(options['output-file'])
    : path.join(process.cwd(), 'data', 'generated', 'ct-posters-2026-04-06.json')

function yearsWithinTolerance(left, right, tolerance = 1) {
  const parsedLeft = yearToNumber(left)

  if (parsedLeft === null || right === null) {
    return false
  }

  return Math.abs(parsedLeft - right) <= tolerance
}

function findCtMatch(seed, ctMovies) {
  if (seed.year === null) {
    return null
  }

  const candidateTitles = [seed.title, ...(seed.aliases ?? [])]

  for (const candidateTitle of candidateTitles) {
    const exact = ctMovies.find(
      (movie) =>
        normalizeTitle(movie.title) === normalizeTitle(candidateTitle) &&
        yearToNumber(movie.year) === seed.year,
    )

    if (exact) {
      return exact
    }
  }

  for (const candidateTitle of candidateTitles) {
    const nearYear = ctMovies.find(
      (movie) =>
        normalizeTitle(movie.title) === normalizeTitle(candidateTitle) &&
        yearsWithinTolerance(movie.year, seed.year),
    )

    if (nearYear) {
      return nearYear
    }
  }

  return null
}

const weightedSeed = JSON.parse(await readFile(weightedSeedPath, 'utf8'))
const { items: ctMovies } = await fetchAllCtMovies()
const matchedCtMovies = weightedSeed.items
  .map((seed) => findCtMatch(seed, ctMovies))
  .filter((item, index, items) => item !== null && items.findIndex((other) => other?.slug === item.slug) === index)

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  locale: 'cs-CZ',
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
  viewport: { width: 1280, height: 900 },
})
const page = await context.newPage()
const items = []

for (const movie of matchedCtMovies) {
  let posterUrl = null
  let title = null

  try {
    await page.goto(movie.url, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.waitForTimeout(1500)

    title = await page.title()
    posterUrl = await page.locator('meta[property="og:image"]').getAttribute('content')
  } catch (error) {
    items.push({
      slug: movie.slug,
      url: movie.url,
      title: movie.title,
      posterUrl: null,
      pageTitle: title,
      error: error instanceof Error ? error.message : 'Unknown error',
    })
    continue
  }

  items.push({
    slug: movie.slug,
    url: movie.url,
    title: movie.title,
    posterUrl,
    pageTitle: title,
    error: null,
  })
}

await browser.close()

const payload = {
  generatedAt: new Date().toISOString(),
  itemCount: items.length,
  items,
}

await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')

console.log(JSON.stringify({ outputPath, itemCount: items.length }, null, 2))
