import { expect, test } from '@playwright/test'
import { getEmailVerificationPin, hasDbUrl } from './helpers/db'

/**
 * Server-side enforcement of the plan's activeJobs policy. The app's form
 * disables Start scrape at the limit, but the API is the enforcement: a fresh
 * free-plan user (limit 1) gets a 201 for the first create and a 409 for the
 * second while the first is still active — driven directly against the
 * endpoints, the way a queue-stuffing caller would.
 *
 * Reads the emailed verification pin straight from the DB. Needs the api
 * running and DATABASE_URL reachable; skips otherwise.
 */

const PASSWORD = 'TestPassw0rd!2026'

async function body(res: { json: () => Promise<unknown> }): Promise<any> {
  return res.json()
}

test.describe('active job limit', () => {
  test.skip(!hasDbUrl(), 'DATABASE_URL not set — cannot read the verification pin')

  test('free plan: second concurrent create is rejected with 409', async ({ request }) => {
    test.setTimeout(60_000)
    const email = `joblimit-${Date.now()}@leadeasygen.dev`
    let access = ''

    await test.step('register and verify', async () => {
      const res = await request.post('/auth/register', {
        data: { email, password: PASSWORD, firstName: 'Jo', lastName: 'Limit' },
      })
      expect(res.ok()).toBeTruthy()
      access = (await body(res)).result.tokens.access

      const pin = await getEmailVerificationPin(email)
      const verify = await request.post('/auth/verify', {
        headers: { Authorization: `Bearer ${access}` },
        data: { token: pin },
      })
      expect((await body(verify)).reason).toBe('VERIFIED')
      const login = await request.post('/auth/login', { data: { email, password: PASSWORD } })
      access = (await body(login)).result.tokens.access
    })

    // Distinct keywords: the second must be a *different* search, otherwise the
    // rolling dedup guard would reject it first (RECENT_DUPLICATE) and we'd be
    // testing dedup, not the active-jobs limit. Two different active jobs are
    // what the limit is about.
    const createTask = (keyword: string) =>
      request.post('/v1/tasks/create', {
        headers: { Authorization: `Bearer ${access}` },
        data: { location: 'Sutton, QC, Canada', keyword, radiusKm: 10 },
      })

    await test.step('first create is accepted', async () => {
      const res = await createTask('restaurants')
      expect(res.status()).toBe(201)
      expect((await body(res)).status).toBe('pending')
    })

    await test.step('second (distinct) create is rejected while the first is active', async () => {
      const res = await createTask('cafes')
      expect(res.status()).toBe(409)
      const json = await body(res)
      expect(json.error).toBe('Active job limit reached')
      expect(json.limit).toBe(1)
    })

    await test.step('only the first task exists', async () => {
      const res = await request.get('/v1/tasks', {
        headers: { Authorization: `Bearer ${access}` },
      })
      expect(res.ok()).toBeTruthy()
      expect(await body(res)).toHaveLength(1)
    })
  })
})
