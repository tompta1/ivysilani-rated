import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

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

const options = parseArgs(process.argv.slice(2))
const weightedFile =
  typeof options['weighted-file'] === 'string'
    ? path.resolve(options['weighted-file'])
    : path.join(process.cwd(), 'data', 'generated', 'weighted-seed-2026-04-06.json')
const postersFile =
  typeof options['posters-file'] === 'string'
    ? path.resolve(options['posters-file'])
    : path.join(process.cwd(), 'data', 'generated', 'ct-posters-2026-04-06.json')
const outputFile =
  typeof options['output-file'] === 'string'
    ? path.resolve(options['output-file'])
    : path.join(process.cwd(), 'data', 'source-core-dataset.json')

const weightedSeed = JSON.parse(await readFile(weightedFile, 'utf8'))
const posters = JSON.parse(await readFile(postersFile, 'utf8'))
const payload = {
  generatedAt: new Date().toISOString(),
  sourceFiles: {
    weightedFile: path.basename(weightedFile),
    postersFile: path.basename(postersFile),
  },
  itemCount: Array.isArray(weightedSeed.items) ? weightedSeed.items.length : 0,
  posterCount: Array.isArray(posters.items) ? posters.items.filter((item) => item.posterUrl !== null).length : 0,
  items: (weightedSeed.items ?? []).map((item) => ({
    title: item.title,
    year: item.year,
    aliases: item.aliases ?? [],
    kinoboxRating: item.kinoboxRating,
    kinoboxRank: item.kinoboxRank,
    kinoboxUrl: item.kinoboxUrl,
    csfdRating: item.csfdRating,
    csfdBestRank: item.csfdBestRank,
    csfdUrl: item.csfdUrl,
    compositeScore: item.compositeScore,
  })),
  posters: (posters.items ?? [])
    .filter((item) => typeof item.slug === 'string' && item.posterUrl !== null)
    .map((item) => ({
      slug: item.slug,
      posterUrl: item.posterUrl,
    })),
}

await mkdir(path.dirname(outputFile), { recursive: true })
await writeFile(outputFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')

console.log(
  JSON.stringify(
    {
      outputFile,
      itemCount: payload.itemCount,
      posterCount: payload.posterCount,
    },
    null,
    2,
  ),
)
