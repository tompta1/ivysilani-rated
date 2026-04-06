import process from 'node:process'
import pg from 'pg'
import { parseArgs } from './lib/args.mjs'
import { ctFilmCategory, fetchAllCtMovies } from './lib/ct-catalogue.mjs'

const { Client } = pg
const options = parseArgs(process.argv.slice(2))
const databaseUrl = process.env.DATABASE_URL ?? process.env.NEON_DATABASE_URL ?? ''

if (databaseUrl.length === 0) {
  throw new Error('Missing DATABASE_URL or NEON_DATABASE_URL')
}

const snapshotDate =
  typeof options['snapshot-date'] === 'string'
    ? options['snapshot-date']
    : new Date().toISOString().slice(0, 10)

const { items, totalCount } = await fetchAllCtMovies()
const payload = {
  category: ctFilmCategory,
  fetchedAt: new Date().toISOString(),
  items,
  itemCount: items.length,
  totalCount,
}

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
      INSERT INTO ct_catalogue_snapshots (
        category_id,
        snapshot_date,
        fetched_at,
        item_count,
        total_count,
        payload_json
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb)
      ON CONFLICT (category_id, snapshot_date)
      DO UPDATE
      SET fetched_at = EXCLUDED.fetched_at,
          item_count = EXCLUDED.item_count,
          total_count = EXCLUDED.total_count,
          payload_json = EXCLUDED.payload_json,
          created_at = now()
    `,
    [
      ctFilmCategory.id,
      snapshotDate,
      payload.fetchedAt,
      payload.itemCount,
      payload.totalCount,
      JSON.stringify(payload),
    ],
  )

  console.log(
    JSON.stringify(
      {
        uploaded: true,
        snapshotDate,
        categoryId: ctFilmCategory.id,
        itemCount: payload.itemCount,
        totalCount: payload.totalCount,
      },
      null,
      2,
    ),
  )
} finally {
  await client.end()
}
