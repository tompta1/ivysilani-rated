import { Pool } from 'pg'

type DatasetSummary = {
  generatedAt: string
  itemCount: number
  posterCount: number
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

async function getLatestDatasetSummary(): Promise<DatasetSummary | null> {
  const client = await getDatasetPool().connect()

  try {
    const result = await client.query<{
      generated_at: string
      item_count: number
      poster_count: number
    }>(
      `
        SELECT generated_at, item_count, poster_count
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

    return {
      generatedAt: result.rows[0].generated_at,
      itemCount: result.rows[0].item_count,
      posterCount: result.rows[0].poster_count,
    }
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
    const dataset = await getLatestDatasetSummary()

    setCorsHeaders(res)
    res.setHeader('Cache-Control', 'no-store')
    res.status(200).json({
      ok: true,
      service: 'ivysilani-rated-api',
      checkedAt: new Date().toISOString(),
      dataset:
        dataset === null
          ? {
              present: false,
            }
          : {
              present: true,
              generatedAt: dataset.generatedAt,
              itemCount: dataset.itemCount,
              posterCount: dataset.posterCount,
            },
    })
  } catch (error) {
    setCorsHeaders(res)
    res.status(500).json({
      ok: false,
      service: 'ivysilani-rated-api',
      checkedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : 'Unknown health error',
    })
  }
}
