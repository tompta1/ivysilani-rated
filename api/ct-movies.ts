import { Pool } from 'pg'

const CT_GRAPHQL_ENDPOINT = 'https://api.ceskatelevize.cz/graphql/'
const CT_FILM_CATEGORY_ID = '3947'
const CT_PAGE_SIZE = 40
const CT_CACHE_MAX_AGE_HOURS = 36

const getCategoryByIdQuery = `
  query GetCategoryById(
    $limit: PaginationAmount!
    $offset: Int!
    $categoryId: String!
    $order: OrderByDirection
    $orderBy: CategoryOrderByType
  ) {
    showFindByGenre(
      limit: $limit
      offset: $offset
      categoryId: $categoryId
      order: $order
      orderBy: $orderBy
    ) {
      items {
        id
        slug
        title
        year
        shortDescription
        __typename
      }
      totalCount
      __typename
    }
  }
`

type CtMovie = {
  id: string
  slug: string
  title: string
  year: string | null
  shortDescription: string | null
  url: string
}

type CtPagePayload = {
  items: CtMovie[]
  totalCount: number
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

function normalizeLimit(rawLimit: unknown): number {
  const numericLimit =
    typeof rawLimit === 'string'
      ? Number.parseInt(rawLimit, 10)
      : Array.isArray(rawLimit)
        ? Number.parseInt(rawLimit[0] ?? '', 10)
        : Number.NaN

  if (Number.isNaN(numericLimit)) {
    return 12
  }

  return Math.min(Math.max(numericLimit, 1), CT_PAGE_SIZE)
}

function isSnapshotFresh(fetchedAt: string): boolean {
  const fetchedAtMs = Date.parse(fetchedAt)

  if (Number.isNaN(fetchedAtMs)) {
    return false
  }

  return Date.now() - fetchedAtMs <= CT_CACHE_MAX_AGE_HOURS * 60 * 60 * 1000
}

function withLimitedItems(payload: CtMoviesResponse, limit: number): CtMoviesResponse {
  return {
    ...payload,
    items: payload.items.slice(0, limit),
    itemCount: Math.min(limit, payload.items.length),
  }
}

async function fetchCtPage(limit: number, offset: number): Promise<CtPagePayload> {
  const response = await fetch(CT_GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      operationName: 'GetCategoryById',
      query: getCategoryByIdQuery,
      variables: {
        categoryId: CT_FILM_CATEGORY_ID,
        limit,
        offset,
        order: 'asc',
        orderBy: 'alphabet',
      },
    }),
  })

  if (!response.ok) {
    throw new Error(`ČT endpoint responded with ${response.status}`)
  }

  const payload = await response.json()
  const sourceItems = payload?.data?.showFindByGenre?.items
  const totalCount = payload?.data?.showFindByGenre?.totalCount

  if (!Array.isArray(sourceItems) || typeof totalCount !== 'number') {
    throw new Error('ČT response shape changed')
  }

  return {
    items: sourceItems.map(
      (item: {
        id: string
        slug: string
        title: string
        year?: string | null
        shortDescription?: string | null
      }) => ({
        id: item.id,
        slug: item.slug,
        title: item.title,
        year: item.year ?? null,
        shortDescription: item.shortDescription ?? null,
        url: `https://www.ceskatelevize.cz/porady/${item.slug}/`,
      }),
    ),
    totalCount,
  }
}

async function fetchCtMovies(limit: number): Promise<CtPagePayload> {
  return fetchCtPage(limit, 0)
}

async function fetchAllCtMovies(): Promise<CtMoviesResponse> {
  const firstPage = await fetchCtPage(CT_PAGE_SIZE, 0)
  const items = [...firstPage.items]

  for (let offset = CT_PAGE_SIZE; offset < firstPage.totalCount; offset += CT_PAGE_SIZE) {
    const page = await fetchCtPage(CT_PAGE_SIZE, offset)
    items.push(...page.items)
  }

  return {
    category: {
      id: CT_FILM_CATEGORY_ID,
      name: 'Filmy',
    },
    fetchedAt: new Date().toISOString(),
    items,
    itemCount: items.length,
    totalCount: firstPage.totalCount,
  }
}

async function getLatestCtSnapshot(): Promise<CtMoviesResponse | null> {
  const client = await getDatasetPool().connect()

  try {
    const result = await client.query<{ payload_json: CtMoviesResponse }>(
      `
        SELECT payload_json
        FROM ct_catalogue_snapshots
        WHERE category_id = $1
        ORDER BY fetched_at DESC, id DESC
        LIMIT 1
      `,
      [CT_FILM_CATEGORY_ID],
    )

    if (result.rowCount === 0) {
      return null
    }

    return result.rows[0].payload_json
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

  const hasExplicitLimit = req.query?.limit !== undefined
  const limit = normalizeLimit(req.query?.limit)

  try {
    let snapshot: CtMoviesResponse | null = null

    try {
      snapshot = await getLatestCtSnapshot()
    } catch {
      snapshot = null
    }

    if (snapshot !== null && isSnapshotFresh(snapshot.fetchedAt)) {
      const payload = hasExplicitLimit ? withLimitedItems(snapshot, limit) : snapshot

      setCorsHeaders(res)
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=86400')
      res.status(200).json({
        ...payload,
        source: 'neon-cache',
      })
      return
    }

    const livePayload = hasExplicitLimit
      ? await fetchCtMovies(limit)
      : await fetchAllCtMovies()
    const payload =
      'category' in livePayload
        ? livePayload
        : {
            category: {
              id: CT_FILM_CATEGORY_ID,
              name: 'Filmy',
            },
            fetchedAt: new Date().toISOString(),
            items: livePayload.items,
            itemCount: livePayload.items.length,
            totalCount: livePayload.totalCount,
          }

    setCorsHeaders(res)
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=86400')
    res.status(200).json({
      ...payload,
      source: snapshot === null ? 'live-no-cache' : 'live-fallback',
    })
  } catch (error) {
    setCorsHeaders(res)
    res.status(502).json({
      error: error instanceof Error ? error.message : 'Unknown proxy error',
    })
  }
}
