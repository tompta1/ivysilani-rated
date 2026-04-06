const CT_GRAPHQL_ENDPOINT = 'https://api.ceskatelevize.cz/graphql/'
const CT_FILM_CATEGORY_ID = '3947'
const CT_PAGE_SIZE = 40

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

async function fetchAllCtMovies(): Promise<CtMovie[]> {
  const firstPage = await fetchCtPage(CT_PAGE_SIZE, 0)
  const items = [...firstPage.items]

  for (let offset = CT_PAGE_SIZE; offset < firstPage.totalCount; offset += CT_PAGE_SIZE) {
    const page = await fetchCtPage(CT_PAGE_SIZE, offset)
    items.push(...page.items)
  }

  return items
}

export default async function handler(req: any, res: any): Promise<void> {
  if (handleOptions(req, res)) {
    return
  }

  try {
    const hasExplicitLimit = req.query?.limit !== undefined
    const payload = hasExplicitLimit
      ? await fetchCtMovies(normalizeLimit(req.query?.limit))
      : { items: await fetchAllCtMovies(), totalCount: 0 }

    const totalCount = hasExplicitLimit ? payload.totalCount : payload.items.length

    setCorsHeaders(res)
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=86400')
    res.status(200).json({
      category: {
        id: CT_FILM_CATEGORY_ID,
        name: 'Filmy',
      },
      fetchedAt: new Date().toISOString(),
      items: payload.items,
      itemCount: payload.items.length,
      totalCount,
    })
  } catch (error) {
    setCorsHeaders(res)
    res.status(502).json({
      error: error instanceof Error ? error.message : 'Unknown proxy error',
    })
  }
}
