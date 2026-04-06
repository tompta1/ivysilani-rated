import { Pool } from 'pg'

type SourceCoreDatasetItem = {
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

type SourceCoreDatasetPoster = {
  slug: string
  posterUrl: string
}

type SourceCoreDataset = {
  generatedAt: string
  itemCount: number
  posterCount: number
  items: SourceCoreDatasetItem[]
  posters: SourceCoreDatasetPoster[]
}

const DATASET_KEY = 'source-core-dataset'

let pool: Pool | null = null

function setCorsHeaders(res: any): void {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
}

function handleOptions(req: any, res: any): boolean {
  if (req.method !== 'OPTIONS') {
    return false
  }

  setCorsHeaders(res)
  res.status(204).end()
  return true
}

function getDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL ?? process.env.NEON_DATABASE_URL ?? ''

  if (databaseUrl.length === 0) {
    throw new Error('Missing DATABASE_URL or NEON_DATABASE_URL')
  }

  return databaseUrl
}

function getDatasetPool(): Pool {
  if (pool !== null) {
    return pool
  }

  pool = new Pool({
    connectionString: getDatabaseUrl(),
    max: 3,
    ssl:
      process.env.PGSSLMODE === 'disable'
        ? false
        : {
            rejectUnauthorized: false,
          },
  })

  return pool
}

async function getLatestSourceCoreDataset(): Promise<SourceCoreDataset | null> {
  const client = await getDatasetPool().connect()

  try {
    const result = await client.query<{ dataset_json: SourceCoreDataset }>(
      `
        SELECT dataset_json
        FROM source_core_dataset_versions
        WHERE dataset_key = $1
        ORDER BY generated_at DESC, id DESC
        LIMIT 1
      `,
      [DATASET_KEY],
    )

    if (result.rowCount === 0) {
      return null
    }

    return result.rows[0].dataset_json
  } finally {
    client.release()
  }
}

export default async function handler(req: any, res: any): Promise<void> {
  if (handleOptions(req, res)) {
    return
  }

  if (req.method !== 'GET') {
    setCorsHeaders(res)
    res.setHeader('Allow', 'GET,OPTIONS')
    res.status(405).json({
      error: 'Method not allowed',
    })
    return
  }

  try {
    const dataset = await getLatestSourceCoreDataset()

    if (dataset === null) {
      setCorsHeaders(res)
      res.status(404).json({
        error: 'Source core dataset not found in Neon',
      })
      return
    }

    setCorsHeaders(res)
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400')
    res.status(200).json(dataset)
  } catch (error) {
    setCorsHeaders(res)
    res.status(502).json({
      error: error instanceof Error ? error.message : 'Unknown source dataset error',
    })
  }
}
