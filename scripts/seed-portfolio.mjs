import { readFileSync } from 'fs'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'

const { Pool } = pg

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const db = drizzle(pool)

// Inline the parser logic by reading the compiled dist
const csvText = readFileSync('/home/runner/workspace/attached_assets/robinhood-export-20260617.csv', 'utf8')

// Dynamic import from compiled dist
const { parseRobinhoodCSV } = await import('/home/runner/workspace/artifacts/api-server/dist/index.mjs')
  .catch(() => null) ?? {}

if (!parseRobinhoodCSV) {
  // Fall back to importing parser source via tsx
  console.error('Cannot import parser from dist — run via tsx instead')
  process.exit(1)
}

const parsed = parseRobinhoodCSV(csvText)
console.log('Parsed:', parsed.positions.length, 'positions,', parsed.options.length, 'options,', parsed.orders.length, 'orders')
console.log('Accounts:', parsed.accountIds)
console.log('Total value:', parsed.totalValue)
await pool.end()
