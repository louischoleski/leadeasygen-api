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
