import { createHash } from 'node:crypto'
import pg from 'pg'

/**
 * Read-only peeks into the api's own database for values that are never
 * returned over the wire — the pending/active MFA secret and the emailed
 * verification pin. Legitimate for an integration test that owns the stack.
 *
 * Uses E2E_DATABASE_URL, falling back to DATABASE_URL.
 */
function connectionString(): string {
  const url = process.env.E2E_DATABASE_URL ?? process.env.DATABASE_URL
  if (!url) throw new Error('E2E_DATABASE_URL / DATABASE_URL not set')
  return url
}

export function hasDbUrl(): boolean {
  return !!(process.env.E2E_DATABASE_URL ?? process.env.DATABASE_URL)
}

async function withClient<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: connectionString() })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

/** The 6-digit email verification pin most recently issued for a user. */
export function getEmailVerificationPin(email: string): Promise<string> {
  return withClient(async (c) => {
    const { rows } = await c.query(
      `SELECT v.token
         FROM fonderie_email_verifications v
         JOIN fonderie_users u ON u.id = v.user_id
        WHERE u.email = $1
        ORDER BY v.created_at DESC
        LIMIT 1`,
      [email],
    )
    if (!rows[0]?.token) throw new Error(`no verification pin for ${email}`)
    return rows[0].token as string
  })
}

/**
 * The base32 MFA secret for a user. During setup it lives in
 * `mfa_secret_pending`; once verified it moves to `mfa_secret`.
 */
export function getMfaSecret(email: string, which: 'pending' | 'active'): Promise<string> {
  const column = which === 'pending' ? 'mfa_secret_pending' : 'mfa_secret'
  return withClient(async (c) => {
    const { rows } = await c.query(`SELECT ${column} AS secret FROM fonderie_users WHERE email = $1`, [email])
    if (!rows[0]?.secret) throw new Error(`no ${which} MFA secret for ${email}`)
    return rows[0].secret as string
  })
}

/**
 * Backdate a task's created_at so a dedup test can prove the rolling window
 * boundary without waiting real days. Only touches created_at — leaving status
 * alone keeps the assertion robust against the live scraper worker (a task
 * outside the window is excluded by the time predicate regardless of status).
 */
export function ageTask(taskId: string, days: number): Promise<void> {
  return withClient(async (c) => {
    await c.query(`UPDATE scrape_tasks SET created_at = now() - ($2 || ' days')::interval WHERE id = $1`, [
      taskId,
      days,
    ])
  })
}

/** The authenticated user's id, for seeding rows attributed to them. */
export function getUserId(email: string): Promise<string> {
  return withClient(async (c) => {
    const { rows } = await c.query(`SELECT id FROM fonderie_users WHERE email = $1`, [email])
    if (!rows[0]?.id) throw new Error(`no user ${email}`)
    return rows[0].id as string
  })
}

interface SearchParams {
  keyword: string
  location: string
  radiusKm: number | null
}

// Mirrors the server's computeSearchKey (api/src/tasks/routes.ts). Kept in sync
// by hand so a seeded row lands on the same dedup key the create endpoint
// computes — the only way to test dedup against a row the live worker won't touch.
function searchKey(p: SearchParams): string {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')
  return createHash('sha256')
    .update(JSON.stringify([norm(p.keyword), norm(p.location), p.radiusKm]))
    .digest('hex')
}

/**
 * Insert a synthetic `complete` scrape task with a chosen number of leads (and
 * the matching dedup key), so a dedup test can assert the F6 rule — a finished
 * run that found nothing is not a duplicate — without racing the live worker
 * (this row is never enqueued).
 */
export function seedCompletedTask(userId: string, search: SearchParams, leadCount: number): Promise<string> {
  const results = JSON.stringify(Array.from({ length: leadCount }, (_, i) => ({ name: `Lead ${i}` })))
  return withClient(async (c) => {
    const { rows } = await c.query(
      `INSERT INTO scrape_tasks (user_id, url, status, params, dedup_key, results)
       VALUES ($1, 'https://maps', 'complete', $2::jsonb, $3, $4::jsonb) RETURNING id`,
      [userId, JSON.stringify(search), searchKey(search), results],
    )
    return rows[0].id as string
  })
}
