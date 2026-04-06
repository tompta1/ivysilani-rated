const endpoint = 'https://api.ceskatelevize.cz/graphql/'

const query = `
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
        __typename
      }
      totalCount
      __typename
    }
  }
`

const response = await fetch(endpoint, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
  },
  body: JSON.stringify({
    operationName: 'GetCategoryById',
    query,
    variables: {
      categoryId: '3947',
      limit: 10,
      offset: 0,
      order: 'asc',
      orderBy: 'alphabet',
    },
  }),
})

if (!response.ok) {
  throw new Error(`CT endpoint responded with ${response.status}`)
}

const payload = await response.json()

console.log(JSON.stringify(payload, null, 2))
