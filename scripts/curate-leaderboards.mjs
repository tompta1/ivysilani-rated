import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { load as loadHtml } from 'cheerio'

const DEFAULT_DATE = new Date().toISOString().slice(0, 10)
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36'
const DEFAULT_ROOT = process.cwd()
const DEFAULT_DATA_DIR = path.join(DEFAULT_ROOT, 'data')
const DEFAULT_RAW_DIR = path.join(DEFAULT_DATA_DIR, 'raw')
const DEFAULT_CURATED_DIR = path.join(DEFAULT_DATA_DIR, 'curated')
const DEFAULT_GENERATED_DIR = path.join(DEFAULT_DATA_DIR, 'generated')

const SOURCE_CONFIG = {
  kinobox: {
    origin: 'https://www.kinobox.cz',
    targets: [1, 2, 3, 4].map((page) => ({
      ref: `page-${String(page).padStart(2, '0')}`,
      rankOffset: (page - 1) * 50,
      url:
        page === 1
          ? 'https://www.kinobox.cz/zebricky/nejlepsi/filmy/ivysilani'
          : `https://www.kinobox.cz/zebricky/nejlepsi/filmy/ivysilani?p=${page}`,
    })),
    hrefPattern: /^https:\/\/www\.kinobox\.cz\/film\/\d+/i,
    blockedPatterns: [
      /security verification/i,
      /cloudflare/i,
      /just a moment/i,
      /captcha/i,
      /attention required/i,
    ],
    rankField: 'rank',
    ratingField: 'rating',
  },
  csfd: {
    origin: 'https://www.csfd.cz',
    targets: Array.from({ length: 10 }, (_, index) => {
      const offset = index * 100

      return {
        ref: `from-${String(offset).padStart(3, '0')}`,
        rankOffset: offset,
        url:
          offset === 0
            ? 'https://www.csfd.cz/zebricky/filmy/nejlepsi/'
            : `https://www.csfd.cz/zebricky/filmy/nejlepsi/?from=${offset}`,
      }
    }),
    hrefPattern: /^https:\/\/www\.csfd\.cz\/film\/\d+/i,
    blockedPatterns: [
      /access denied/i,
      /botstopper/i,
      /security check/i,
      /captcha/i,
    ],
    rankField: 'bestRank',
    ratingField: 'rating',
  },
}

function printHelp() {
  console.log(`
Usage:
  npm run curate:leaders -- <command> [options]

Commands:
  capture   Fetch leaderboard pages and store raw HTML snapshots.
  extract   Parse saved HTML files into curated per-source JSON.
  merge     Merge curated Kinobox + ČSFD JSON into one app seed JSON.
  all       Run capture -> extract -> merge in one pass.
  help      Show this help text.

Options:
  --source <kinobox|csfd|all>   Source to process. Default: all
  --date <YYYY-MM-DD>           Snapshot date. Default: today
  --force                       Overwrite existing raw HTML snapshots
  --skip-capture                For 'all', reuse existing raw HTML files
  --cookie "<cookie header>"    Optional cookie header for fetch capture
  --user-agent "<ua>"           Optional user agent for fetch capture
  --alias-file <path>           Optional alias JSON for merge
  --raw-dir <path>              Raw HTML root. Default: data/raw
  --curated-dir <path>          Curated JSON root. Default: data/curated
  --generated-dir <path>        Generated JSON root. Default: data/generated

Suggested workflow:
  1. npm run curate:leaders -- capture --source kinobox --date 2026-04-06
  2. npm run curate:leaders -- capture --source csfd --date 2026-04-06
  3. If a site blocks the fetch, save the page HTML manually into:
     data/raw/<source>/<date>/<ref>.html
  4. npm run curate:leaders -- extract --source all --date 2026-04-06
  5. npm run curate:leaders -- merge --date 2026-04-06

Outputs:
  data/curated/kinobox-<date>.json
  data/curated/csfd-<date>.json
  data/generated/weighted-seed-<date>.json
`)
}

function parseArgs(argv) {
  const [command = 'help', ...rest] = argv
  const options = {}

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]

    if (!token.startsWith('--')) {
      continue
    }

    const [rawKey, inlineValue] = token.slice(2).split('=', 2)
    const key = rawKey
    const next = rest[index + 1]
    const value =
      inlineValue !== undefined
        ? inlineValue
        : next !== undefined && !next.startsWith('--')
          ? (index += 1, next)
          : true

    options[key] = value
  }

  return { command, options }
}

function getDateOption(options) {
  const value = typeof options.date === 'string' ? options.date : DEFAULT_DATE

  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Invalid --date value: ${value}`)
  }

  return value
}

function getSources(options) {
  const source = typeof options.source === 'string' ? options.source : 'all'

  if (source === 'all') {
    return ['kinobox', 'csfd']
  }

  if (!(source in SOURCE_CONFIG)) {
    throw new Error(`Unknown --source value: ${source}`)
  }

  return [source]
}

function cleanText(value) {
  return value.replace(/\s+/g, ' ').replace(/\u00a0/g, ' ').trim()
}

function normalizeTitle(value) {
  return cleanText(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[„“"'.:!?(),[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

function detectBlocked(source, html, statusCode) {
  if (source === 'kinobox' && html.includes('"filmsOut"')) {
    return false
  }

  if (source === 'csfd' && html.includes('article-content-toplist')) {
    return false
  }

  if (statusCode >= 400) {
    return true
  }

  return SOURCE_CONFIG[source].blockedPatterns.some((pattern) => pattern.test(html))
}

function slugifyTitle(value) {
  return cleanText(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
}

function parseKinoboxNextData(html, pageRef) {
  const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/)

  if (!match) {
    return []
  }

  let payload

  try {
    payload = JSON.parse(match[1])
  } catch {
    return []
  }

  const items = payload?.props?.pageProps?.filmsOut?.items

  if (!Array.isArray(items)) {
    return []
  }

  return items.map((item, index) => {
    const title = cleanText(item?.name ?? '')
    const url =
      typeof item?.id === 'number'
        ? `https://www.kinobox.cz/film/${item.id}-${slugifyTitle(title)}`
        : null

    return {
      title,
      year: Number.isFinite(item?.year) ? item.year : null,
      rating: Number.isFinite(item?.score?.score) ? item.score.score : null,
      url,
      rawText: item?.summary ?? null,
      pageRef,
      rank: pageRefRankBase('kinobox', pageRef) + index + 1,
    }
  })
}

function absoluteUrl(source, href) {
  try {
    return new URL(href, SOURCE_CONFIG[source].origin).toString()
  } catch {
    return null
  }
}

function isLikelyFilmTitle(title) {
  return /[A-Za-zÀ-ž]/.test(title) && title.length >= 2 && title.length <= 140
}

function extractYear(text) {
  const matches = [...text.matchAll(/\b(18|19|20)\d{2}\b/g)]
  const currentYear = new Date().getFullYear() + 1

  for (const match of matches) {
    const year = Number.parseInt(match[0], 10)

    if (year >= 1890 && year <= currentYear) {
      return year
    }
  }

  return null
}

function extractRating(text) {
  const matches = [...text.matchAll(/\b(100|[1-9]?\d)(?:[.,]\d+)?\s*%/g)]

  for (const match of matches) {
    const value = Number.parseInt(match[1], 10)

    if (value >= 1 && value <= 100) {
      return value
    }
  }

  return null
}

function parseCsfdArticles(html, pageRef) {
  const $ = loadHtml(html)
  const items = []

  $('article.article.article-poster-60').each((index, article) => {
    const titleAnchor = $(article).find('a.film-title-name').first()
    const title = cleanText(titleAnchor.attr('title') ?? titleAnchor.text())
    const url = absoluteUrl('csfd', titleAnchor.attr('href') ?? '')
    const ratingText = cleanText($(article).find('.rating-average').first().text())
    const yearText = cleanText($(article).find('.film-title-info .info').first().text())
    const rankText = cleanText($(article).find('.film-title-user').first().text())
    const rawText = cleanText($(article).text())
    const rating = extractRating(ratingText)
    const year = extractYear(yearText)
    const bestRank = Number.parseInt(rankText.replace(/[^\d]/g, ''), 10)

    if (!isLikelyFilmTitle(title) || url === null || !SOURCE_CONFIG.csfd.hrefPattern.test(url)) {
      return
    }

    items.push({
      title,
      year,
      rating,
      url,
      rawText,
      pageRef,
      bestRank: Number.isNaN(bestRank) ? pageRefRankBase('csfd', pageRef) + index + 1 : bestRank,
    })
  })

  return items
}

function getSnippet($, element) {
  let current = $(element)
  const anchorText = cleanText($(element).text())

  for (let depth = 0; depth < 6 && current.length > 0; depth += 1) {
    const text = cleanText(current.text())

    if (
      text.length >= Math.max(anchorText.length + 4, 12) &&
      text.length <= 360 &&
      (anchorText.length === 0 || text.includes(anchorText))
    ) {
      return text
    }

    current = current.parent()
  }

  return cleanText($(element).parent().text()).slice(0, 360)
}

function parseStructuredItems(source, html, pageRef) {
  const $ = loadHtml(html)
  const structuredItems = []

  $('script[type="application/ld+json"]').each((_, script) => {
    const raw = $(script).html()

    if (!raw) {
      return
    }

    let parsed

    try {
      parsed = JSON.parse(raw)
    } catch {
      return
    }

    const queue = Array.isArray(parsed) ? [...parsed] : [parsed]

    while (queue.length > 0) {
      const node = queue.shift()

      if (!node || typeof node !== 'object') {
        continue
      }

      if (Array.isArray(node.itemListElement)) {
        for (const entry of node.itemListElement) {
          const item = entry?.item ?? entry
          const title = cleanText(item?.name ?? entry?.name ?? '')
          const url = absoluteUrl(source, item?.url ?? entry?.url ?? '')

          if (!isLikelyFilmTitle(title) || url === null || !SOURCE_CONFIG[source].hrefPattern.test(url)) {
            continue
          }

          structuredItems.push({
            title,
            url,
            pageRef,
            sourceOrder: Number.isFinite(entry?.position) ? Number(entry.position) : null,
          })
        }
      }

      for (const value of Object.values(node)) {
        if (value && typeof value === 'object') {
          queue.push(value)
        }
      }
    }
  })

  return structuredItems
}

function parseAnchorItems(source, html, pageRef) {
  const $ = loadHtml(html)
  const candidates = []

  $('a[href]').each((index, anchor) => {
    const title = cleanText($(anchor).text())
    const href = $(anchor).attr('href') ?? ''
    const url = absoluteUrl(source, href)

    if (!isLikelyFilmTitle(title) || url === null || !SOURCE_CONFIG[source].hrefPattern.test(url)) {
      return
    }

    const snippet = getSnippet($, anchor)
    const year = extractYear(snippet)
    const rating = extractRating(snippet)
    const score = (rating === null ? 0 : 2) + (year === null ? 0 : 1)

    if (score < 2) {
      return
    }

    candidates.push({
      title,
      url,
      year,
      rating,
      rawText: snippet,
      pageRef,
      sourceOrder: index + 1,
    })
  })

  return dedupeByUrlOrTitle(candidates)
}

function dedupeByUrlOrTitle(items) {
  const seen = new Map()

  for (const item of items) {
    const key = item.url ?? `${normalizeTitle(item.title)}::${item.year ?? 'na'}`
    const existing = seen.get(key)

    if (!existing) {
      seen.set(key, item)
      continue
    }

    const existingTextLength = existing.rawText?.length ?? 0
    const nextTextLength = item.rawText?.length ?? 0

    if (nextTextLength > existingTextLength) {
      seen.set(key, { ...existing, ...item })
      continue
    }

    seen.set(key, {
      ...existing,
      year: existing.year ?? item.year,
      rating: existing.rating ?? item.rating,
    })
  }

  return [...seen.values()]
}

function pageRefRankBase(source, pageRef) {
  if (source === 'kinobox') {
    const match = pageRef.match(/page-(\d+)/)

    if (!match) {
      return 0
    }

    return (Number.parseInt(match[1], 10) - 1) * 50
  }

  const match = pageRef.match(/from-(\d+)/)

  return match ? Number.parseInt(match[1], 10) : 0
}

function mergeStructuredAndAnchorItems(source, structuredItems, anchorItems, pageRef) {
  const anchorByUrl = new Map(anchorItems.map((item) => [item.url, item]))

  if (structuredItems.length === 0) {
    return anchorItems.map((item, index) => ({
      title: item.title,
      year: item.year ?? null,
      rating: item.rating ?? null,
      url: item.url,
      rawText: item.rawText ?? null,
      pageRef,
      [SOURCE_CONFIG[source].rankField]: pageRefRankBase(source, pageRef) + index + 1,
    }))
  }

  return structuredItems.map((item, index) => {
    const anchor = anchorByUrl.get(item.url)
    const rankFromStructured =
      item.sourceOrder === null ? pageRefRankBase(source, pageRef) + index + 1 : pageRefRankBase(source, pageRef) + item.sourceOrder

    return {
      title: item.title,
      year: anchor?.year ?? null,
      rating: anchor?.rating ?? null,
      url: item.url,
      rawText: anchor?.rawText ?? null,
      pageRef,
      [SOURCE_CONFIG[source].rankField]: rankFromStructured,
    }
  })
}

function mergeSourceItems(items, source) {
  const rankField = SOURCE_CONFIG[source].rankField
  const merged = new Map()

  for (const item of items) {
    const key = item.url ?? `${normalizeTitle(item.title)}::${item.year ?? 'na'}`
    const existing = merged.get(key)

    if (!existing) {
      merged.set(key, item)
      continue
    }

    merged.set(key, {
      ...existing,
      year: existing.year ?? item.year,
      rating: existing.rating ?? item.rating,
      rawText:
        (existing.rawText?.length ?? 0) >= (item.rawText?.length ?? 0)
          ? existing.rawText
          : item.rawText,
      [rankField]: Math.min(existing[rankField], item[rankField]),
    })
  }

  return [...merged.values()].sort((left, right) => left[rankField] - right[rankField])
}

async function ensureDir(dirPath) {
  await mkdir(dirPath, { recursive: true })
}

async function pathExists(filePath) {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

async function captureSource(source, options) {
  const date = getDateOption(options)
  const rawRoot = typeof options['raw-dir'] === 'string' ? options['raw-dir'] : DEFAULT_RAW_DIR
  const targetDir = path.join(rawRoot, source, date)
  const cookie = typeof options.cookie === 'string' ? options.cookie : null
  const userAgent = typeof options['user-agent'] === 'string' ? options['user-agent'] : DEFAULT_USER_AGENT
  const shouldForce = options.force === true
  const report = []

  await ensureDir(targetDir)

  for (const target of SOURCE_CONFIG[source].targets) {
    const filePath = path.join(targetDir, `${target.ref}.html`)

    if (!shouldForce && (await pathExists(filePath))) {
      report.push({
        ref: target.ref,
        url: target.url,
        filePath,
        status: 'skipped-existing',
      })
      continue
    }

    const response = await fetch(target.url, {
      headers: {
        'accept-language': 'cs-CZ,cs;q=0.9,en;q=0.8',
        'cache-control': 'no-cache',
        'pragma': 'no-cache',
        'user-agent': userAgent,
        ...(cookie === null ? {} : { cookie }),
      },
    })

    const html = await response.text()
    const blocked = detectBlocked(source, html, response.status)

    await writeFile(filePath, html, 'utf8')

    report.push({
      ref: target.ref,
      url: target.url,
      filePath,
      status: response.status,
      blocked,
      bytes: html.length,
    })
  }

  const reportPath = path.join(targetDir, 'capture-report.json')

  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

  console.log(JSON.stringify({ source, date, reportPath, captures: report }, null, 2))
}

async function extractSource(source, options) {
  const date = getDateOption(options)
  const rawRoot = typeof options['raw-dir'] === 'string' ? options['raw-dir'] : DEFAULT_RAW_DIR
  const curatedRoot = typeof options['curated-dir'] === 'string' ? options['curated-dir'] : DEFAULT_CURATED_DIR
  const inputDir = path.join(rawRoot, source, date)
  const outputPath = path.join(curatedRoot, `${source}-${date}.json`)

  await ensureDir(curatedRoot)

  const fileNames = (await readdir(inputDir))
    .filter((fileName) => fileName.endsWith('.html'))
    .sort((left, right) => left.localeCompare(right))

  if (fileNames.length === 0) {
    throw new Error(`No HTML files found in ${inputDir}`)
  }

  const files = []
  const sourceItems = []

  for (const fileName of fileNames) {
    const filePath = path.join(inputDir, fileName)
    const html = await readFile(filePath, 'utf8')
    const pageRef = fileName.replace(/\.html$/i, '')
    const blocked = detectBlocked(source, html, 200)
    const structuredItems = parseStructuredItems(source, html, pageRef)
    const anchorItems = parseAnchorItems(source, html, pageRef)
    const pageItems =
      source === 'csfd'
        ? parseCsfdArticles(html, pageRef)
        : source === 'kinobox'
          ? parseKinoboxNextData(html, pageRef)
          : mergeStructuredAndAnchorItems(source, structuredItems, anchorItems, pageRef)

    sourceItems.push(...pageItems)
    files.push({
      fileName,
      pageRef,
      blocked,
      structuredCount: structuredItems.length,
      anchorCount: anchorItems.length,
      extractedCount: pageItems.length,
    })
  }

  const items = mergeSourceItems(sourceItems, source)
  const payload = {
    source,
    date,
    generatedAt: new Date().toISOString(),
    files,
    items,
  }

  await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')

  console.log(JSON.stringify({ source, date, outputPath, itemCount: items.length, files }, null, 2))
}

async function loadAliasMap(aliasFilePath) {
  if (!aliasFilePath || !(await pathExists(aliasFilePath))) {
    return new Map()
  }

  const payload = JSON.parse(await readFile(aliasFilePath, 'utf8'))
  const map = new Map()

  if (!Array.isArray(payload)) {
    return map
  }

  for (const entry of payload) {
    if (!entry || typeof entry.title !== 'string' || !Array.isArray(entry.aliases)) {
      continue
    }

    const key = `${normalizeTitle(entry.title)}::${entry.year ?? 'na'}`
    map.set(key, entry.aliases.filter((value) => typeof value === 'string'))
  }

  return map
}

function getItemAliases(aliasMap, item) {
  const exactKey = `${normalizeTitle(item.title)}::${item.year ?? 'na'}`
  const titleOnlyKey = `${normalizeTitle(item.title)}::na`

  return aliasMap.get(exactKey) ?? aliasMap.get(titleOnlyKey) ?? []
}

function findCrossSourceMatch(target, candidates, aliasMap) {
  const targetAliases = getItemAliases(aliasMap, target)
  const targetNames = [target.title, ...targetAliases].map(normalizeTitle)

  for (const candidate of candidates) {
    const candidateAliases = getItemAliases(aliasMap, candidate)
    const candidateNames = [candidate.title, ...candidateAliases].map(normalizeTitle)
    const titleMatches = targetNames.some((name) => candidateNames.includes(name))

    if (!titleMatches) {
      continue
    }

    if (target.year !== null && candidate.year !== null && target.year !== candidate.year) {
      continue
    }

    return candidate
  }

  return null
}

function computeCompositeScore(kinoboxRating, csfdRating) {
  if (kinoboxRating === null && csfdRating === null) {
    return null
  }

  if (kinoboxRating === null) {
    return csfdRating
  }

  if (csfdRating === null) {
    return kinoboxRating
  }

  return (kinoboxRating * 0.5) + (csfdRating * 0.5)
}

async function mergeSources(options) {
  const date = getDateOption(options)
  const curatedRoot = typeof options['curated-dir'] === 'string' ? options['curated-dir'] : DEFAULT_CURATED_DIR
  const generatedRoot = typeof options['generated-dir'] === 'string' ? options['generated-dir'] : DEFAULT_GENERATED_DIR
  const aliasFile =
    typeof options['alias-file'] === 'string'
      ? options['alias-file']
      : path.join(DEFAULT_DATA_DIR, 'title-aliases.json')
  const kinoboxPath = path.join(curatedRoot, `kinobox-${date}.json`)
  const csfdPath = path.join(curatedRoot, `csfd-${date}.json`)

  if (!(await pathExists(kinoboxPath))) {
    throw new Error(`Missing curated Kinobox JSON: ${kinoboxPath}`)
  }

  if (!(await pathExists(csfdPath))) {
    throw new Error(`Missing curated ČSFD JSON: ${csfdPath}`)
  }

  await ensureDir(generatedRoot)

  const kinoboxPayload = JSON.parse(await readFile(kinoboxPath, 'utf8'))
  const csfdPayload = JSON.parse(await readFile(csfdPath, 'utf8'))
  const aliasMap = await loadAliasMap(aliasFile)
  const merged = []
  const matchedCsfd = new Set()

  for (const kinoboxItem of kinoboxPayload.items) {
    const csfdItem = findCrossSourceMatch(kinoboxItem, csfdPayload.items, aliasMap)

    if (csfdItem) {
      matchedCsfd.add(csfdItem.url ?? `${normalizeTitle(csfdItem.title)}::${csfdItem.year ?? 'na'}`)
    }

    merged.push({
      title: kinoboxItem.title,
      year: kinoboxItem.year,
      aliases: getItemAliases(aliasMap, kinoboxItem),
      kinoboxRating: kinoboxItem.rating,
      kinoboxRank: kinoboxItem.rank,
      kinoboxUrl: kinoboxItem.url,
      csfdRating: csfdItem?.rating ?? null,
      csfdBestRank: csfdItem?.bestRank ?? null,
      csfdUrl: csfdItem?.url ?? null,
      compositeScore: computeCompositeScore(kinoboxItem.rating, csfdItem?.rating ?? null),
    })
  }

  for (const csfdItem of csfdPayload.items) {
    const key = csfdItem.url ?? `${normalizeTitle(csfdItem.title)}::${csfdItem.year ?? 'na'}`

    if (matchedCsfd.has(key)) {
      continue
    }

    merged.push({
      title: csfdItem.title,
      year: csfdItem.year,
      aliases: getItemAliases(aliasMap, csfdItem),
      kinoboxRating: null,
      kinoboxRank: null,
      kinoboxUrl: null,
      csfdRating: csfdItem.rating,
      csfdBestRank: csfdItem.bestRank,
      csfdUrl: csfdItem.url,
      compositeScore: computeCompositeScore(null, csfdItem.rating),
    })
  }

  merged.sort((left, right) => {
    const leftScore = left.compositeScore ?? -1
    const rightScore = right.compositeScore ?? -1

    if (rightScore !== leftScore) {
      return rightScore - leftScore
    }

    const leftKinoboxRank = left.kinoboxRank ?? Number.POSITIVE_INFINITY
    const rightKinoboxRank = right.kinoboxRank ?? Number.POSITIVE_INFINITY

    if (leftKinoboxRank !== rightKinoboxRank) {
      return leftKinoboxRank - rightKinoboxRank
    }

    return left.title.localeCompare(right.title, 'cs')
  })

  const outputPath = path.join(generatedRoot, `weighted-seed-${date}.json`)
  const payload = {
    date,
    generatedAt: new Date().toISOString(),
    sources: {
      kinobox: kinoboxPath,
      csfd: csfdPath,
    },
    aliasFile: await pathExists(aliasFile) ? aliasFile : null,
    itemCount: merged.length,
    items: merged,
  }

  await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')

  console.log(JSON.stringify({ date, outputPath, itemCount: merged.length }, null, 2))
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2))

  if (command === 'help') {
    printHelp()
    return
  }

  if (command === 'capture') {
    for (const source of getSources(options)) {
      await captureSource(source, options)
    }

    return
  }

  if (command === 'extract') {
    for (const source of getSources(options)) {
      await extractSource(source, options)
    }

    return
  }

  if (command === 'merge') {
    await mergeSources(options)
    return
  }

  if (command === 'all') {
    const sources = getSources(options)

    if (options['skip-capture'] !== true) {
      for (const source of sources) {
        await captureSource(source, options)
      }
    }

    for (const source of sources) {
      await extractSource(source, options)
    }

    await mergeSources(options)
    return
  }

  throw new Error(`Unknown command: ${command}`)
}

try {
  await main()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
