export const CT_GRAPHQL_ENDPOINT = 'https://api.ceskatelevize.cz/graphql/'
export const CT_FILM_CATEGORY_ID = '3947'
export const CT_PAGE_SIZE = 40

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

export function normalizeLimit(rawLimit) {
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

async function fetchCtPage(limit, offset) {
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
    items: sourceItems.map((item) => ({
      id: item.id,
      slug: item.slug,
      title: item.title,
      year: item.year ?? null,
      shortDescription: item.shortDescription ?? null,
      url: `https://www.ceskatelevize.cz/porady/${item.slug}/`,
    })),
    totalCount,
  }
}

export async function fetchCtMovies(limit) {
  return fetchCtPage(limit, 0)
}

export async function fetchAllCtMovies() {
  const firstPage = await fetchCtPage(CT_PAGE_SIZE, 0)
  const items = [...firstPage.items]

  for (let offset = CT_PAGE_SIZE; offset < firstPage.totalCount; offset += CT_PAGE_SIZE) {
    const page = await fetchCtPage(CT_PAGE_SIZE, offset)
    items.push(...page.items)
  }

  return {
    items,
    totalCount: firstPage.totalCount,
  }
}

export const ctFilmCategory = {
  id: CT_FILM_CATEGORY_ID,
  name: 'Filmy',
}
