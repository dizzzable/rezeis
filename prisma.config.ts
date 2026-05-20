import path from 'node:path'
import dotenv from 'dotenv'
import { defineConfig } from 'prisma/config'

dotenv.config()

function buildDatabaseUrl(): string {
  // Support explicit DATABASE_URL for backward compatibility
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL
  }
  const host = process.env.DATABASE_HOST ?? 'localhost'
  const port = process.env.DATABASE_PORT ?? '5432'
  const name = process.env.DATABASE_NAME ?? 'rezeis'
  const user = process.env.DATABASE_USER ?? 'rezeis'
  const password = encodeURIComponent(process.env.DATABASE_PASSWORD ?? '')
  return `postgresql://${user}:${password}@${host}:${port}/${name}`
}

const databaseUrl = buildDatabaseUrl()

export default defineConfig({
  earlyAccess: true,
  schema: path.join(__dirname, 'prisma', 'schema.prisma'),
  datasource: {
    url: databaseUrl,
  },
  migrate: {
    url: databaseUrl,
  },
})
