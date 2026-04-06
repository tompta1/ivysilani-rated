import { readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const { Client } = pg
const databaseUrl = process.env.DATABASE_URL ?? process.env.NEON_DATABASE_URL ?? ''

if (databaseUrl.length === 0) {
  throw new Error('Missing DATABASE_URL or NEON_DATABASE_URL')
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const sqlPath = path.join(scriptDir, '..', 'db', 'source-core-dataset.sql')
const sql = await readFile(sqlPath, 'utf8')
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
  await client.query(sql)
  console.log(JSON.stringify({ applied: true, sqlPath }, null, 2))
} finally {
  await client.end()
}
