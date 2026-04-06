import { readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import pg from 'pg'

const { Client } = pg

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

const databaseUrl = process.env.DATABASE_URL ?? process.env.NEON_DATABASE_URL ?? ''

if (databaseUrl.length === 0) {
  throw new Error('Missing DATABASE_URL or NEON_DATABASE_URL')
}

const options = parseArgs(process.argv.slice(2))
const datasetFile =
  typeof options['dataset-file'] === 'string'
    ? path.resolve(options['dataset-file'])
    : path.join(process.cwd(), 'data', 'source-core-dataset.json')
const dataset = JSON.parse(await readFile(datasetFile, 'utf8'))
const client = new Client({
  connectionString: databaseUrl,
  ssl:
    process.env.PGSSLMODE === 'disable'
      ? false
      : {
          rejectUnauthorized: false,
        },
})

await client.connect()

try {
  await client.query(
    `
      INSERT INTO source_core_dataset_versions (
        dataset_key,
        generated_at,
        item_count,
        poster_count,
        dataset_json
      )
      VALUES ($1, $2, $3, $4, $5::jsonb)
      ON CONFLICT (dataset_key)
      DO UPDATE
      SET generated_at = EXCLUDED.generated_at,
          item_count = EXCLUDED.item_count,
          poster_count = EXCLUDED.poster_count,
          dataset_json = EXCLUDED.dataset_json,
          created_at = now()
    `,
    [
      'source-core-dataset',
      dataset.generatedAt,
      dataset.itemCount,
      dataset.posterCount,
      JSON.stringify(dataset),
    ],
  )

  console.log(
    JSON.stringify(
      {
        datasetFile,
        uploaded: true,
        itemCount: dataset.itemCount,
        posterCount: dataset.posterCount,
      },
      null,
      2,
    ),
  )
} finally {
  await client.end()
}
