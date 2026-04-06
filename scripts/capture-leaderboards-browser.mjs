import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { chromium } from 'playwright'

const DEFAULT_DATE = new Date().toISOString().slice(0, 10)
const DEFAULT_RAW_DIR = path.join(process.cwd(), 'data', 'raw')

const TARGETS = {
  kinobox: [1, 2, 3, 4].map((page) => ({
    ref: `page-${String(page).padStart(2, '0')}`,
    url:
      page === 1
        ? 'https://www.kinobox.cz/zebricky/nejlepsi/filmy/ivysilani'
        : `https://www.kinobox.cz/zebricky/nejlepsi/filmy/ivysilani?p=${page}`,
  })),
  csfd: Array.from({ length: 10 }, (_, index) => {
    const offset = index * 100

    return {
      ref: `from-${String(offset).padStart(3, '0')}`,
      url:
        offset === 0
          ? 'https://www.csfd.cz/zebricky/filmy/nejlepsi/'
          : `https://www.csfd.cz/zebricky/filmy/nejlepsi/?from=${offset}`,
    }
  }),
}

function parseArgs(argv) {
  const options = {}

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]

    if (!token.startsWith('--')) {
      continue
    }

    const [rawKey, inlineValue] = token.slice(2).split('=', 2)
    const next = argv[index + 1]
    const value =
      inlineValue !== undefined
        ? inlineValue
        : next !== undefined && !next.startsWith('--')
          ? (index += 1, next)
          : true

    options[rawKey] = value
  }

  return options
}

function getSources(options) {
  const source = typeof options.source === 'string' ? options.source : 'all'

  if (source === 'all') {
    return ['kinobox', 'csfd']
  }

  if (!(source in TARGETS)) {
    throw new Error(`Neznámý zdroj: ${source}`)
  }

  return [source]
}

async function dismissKinoboxConsent(page) {
  const selectors = [
    'button:has-text("Souhlasím")',
    'button:has-text("Přijmout")',
    'button:has-text("Povolit vše")',
    'button:has-text("Accept")',
  ]

  for (const selector of selectors) {
    const button = page.locator(selector).first()

    if ((await button.count()) === 0) {
      continue
    }

    try {
      await button.click({ timeout: 1500 })
      await page.waitForTimeout(800)
      return
    } catch {
      continue
    }
  }
}

const options = parseArgs(process.argv.slice(2))
const date = typeof options.date === 'string' ? options.date : DEFAULT_DATE
const rawDir = typeof options['raw-dir'] === 'string' ? path.resolve(options['raw-dir']) : DEFAULT_RAW_DIR
const sources = getSources(options)
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  locale: 'cs-CZ',
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
  viewport: { width: 1440, height: 1600 },
})

try {
  for (const source of sources) {
    const targetDir = path.join(rawDir, source, date)
    const report = []

    await mkdir(targetDir, { recursive: true })

    for (const target of TARGETS[source]) {
      const page = await context.newPage()
      let status = null
      let error = null
      let html = ''

      try {
        const response = await page.goto(target.url, {
          waitUntil: 'domcontentloaded',
          timeout: 60000,
        })

        status = response?.status() ?? null

        if (source === 'kinobox') {
          await dismissKinoboxConsent(page)
        }

        await page.waitForTimeout(1500)
        html = await page.content()
      } catch (caughtError) {
        error = caughtError instanceof Error ? caughtError.message : 'Neznámá chyba'
      } finally {
        await page.close()
      }

      const outputFile = path.join(targetDir, `${target.ref}.html`)
      await writeFile(outputFile, html, 'utf8')

      report.push({
        ref: target.ref,
        url: target.url,
        status,
        bytes: html.length,
        error,
        outputFile,
      })
    }

    await writeFile(path.join(targetDir, 'capture-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    console.log(JSON.stringify({ source, date, captures: report.length, targetDir }, null, 2))
  }
} finally {
  await browser.close()
}
