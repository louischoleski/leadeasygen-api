import { expect, test } from '@playwright/test'
import { ageTask, getEmailVerificationPin, getUserId, hasDbUrl, seedCompletedTask } from './helpers/db'

/**
 * Per-user, rolling-window duplicate detection for scrape jobs. The same search
 * (location + keyword + radius) run again within the window is a duplicate: the
 * create endpoint returns 409 RECENT_DUPLICATE pointing at the existing job
 * instead of spinning up a second one. force:true is the caller's explicit
 * override, and a search older than the window is fair game again.
 *
 * Assertions are deliberately worker-independent: dedup is decided by the
 * search key + a created_at window, so the live scraper flipping a job's status
 * can't change any outcome asserted here. "force bypassed dedup" is asserted as
 * "reason is not RECENT_DUPLICATE" (it may then 201-create or 409-hit the
 * active-job limit — both prove it got past the dedup check).
 *
 * Needs the api running and DATABASE_URL reachable; skips otherwise.
 */

const PASSWORD = 'TestPassw0rd!2026'

async function body(res: { json: () => Promise<unknown> }): Promise<any> {
  return res.json()
}

test.describe('duplicate scrape job', () => {
  test.skip(!hasDbUrl(), 'DATABASE_URL not set — cannot age a task to test the window')

  test('same search within the window is deduped; force and age override', async ({ request }) => {
    test.setTimeout(60_000)
    const email = `dupjob-${Date.now()}@leadeasygen.dev`
    let access = ''

    await test.step('register and verify', async () => {
      const res = await request.post('/auth/register', {
        data: { email, password: PASSWORD, firstName: 'Dup', lastName: 'Job' },
      })
      expect(res.ok()).toBeTruthy()
      access = (await body(res)).result.tokens.access
      const pin = await getEmailVerificationPin(email)
      await request.post('/auth/verify', {
        headers: { Authorization: `Bearer ${access}` },
        data: { token: pin },
      })
      const login = await request.post('/auth/login', { data: { email, password: PASSWORD } })
      access = (await body(login)).result.tokens.access
    })

    const create = (data: Record<string, unknown>) =>
      request.post('/v1/tasks/create', { headers: { Authorization: `Bearer ${access}` }, data })
    const search = { location: 'Sutton, QC, Canada', keyword: 'restaurants', radiusKm: 10 }

    let firstId = ''
    await test.step('first create is accepted', async () => {
      const res = await create(search)
      expect(res.status()).toBe(201)
      firstId = (await body(res)).taskId
      expect(firstId).toBeTruthy()
    })

    await test.step('identical resubmit is deduped, naming the existing job', async () => {
      // Different casing + whitespace — normalization must still collapse it.
      const res = await create({ location: '  sutton, QC,  Canada ', keyword: 'Restaurants', radiusKm: 10 })
      expect(res.status()).toBe(409)
      const json = await body(res)
      expect(json.reason).toBe('RECENT_DUPLICATE')
      expect(json.details.existingTaskId).toBe(firstId)
    })

    let forcedId: string | undefined
    await test.step('force bypasses the dedup check', async () => {
      const res = await create({ ...search, force: true })
      // 201 (created) or 409 active-job-limit — either way it got past dedup.
      const json = await body(res)
      expect(json.reason).not.toBe('RECENT_DUPLICATE')
      forcedId = json.taskId
    })

    await test.step('a search older than the window is no longer a duplicate', async () => {
      // Push every in-window match (the first job, and any the force created)
      // out past 30 days, then the same search is fresh again.
      await ageTask(firstId, 40)
      if (forcedId) await ageTask(forcedId, 40)
      const res = await create(search)
      expect((await body(res)).reason).not.toBe('RECENT_DUPLICATE')
    })
  })

  // F6: a completed run that found nothing shouldn't block a retry. Uses seeded
  // rows (never enqueued) so the assertion is immune to the live scraper.
  test('a completed run is a duplicate only if it found leads', async ({ request }) => {
    test.setTimeout(60_000)
    const email = `dupzero-${Date.now()}@leadeasygen.dev`
    const reg = await request.post('/auth/register', { data: { email, password: PASSWORD } })
    expect(reg.ok()).toBeTruthy()
    const access = (await body(reg)).result.tokens.access
    const uid = await getUserId(email)
    const create = (data: Record<string, unknown>) =>
      request.post('/v1/tasks/create', { headers: { Authorization: `Bearer ${access}` }, data })

    await test.step('completed WITH leads → duplicate', async () => {
      const search = { location: 'Leadville, QC', keyword: 'has-leads', radiusKm: 10 }
      await seedCompletedTask(uid, search, 3)
      const res = await create(search)
      expect(res.status()).toBe(409)
      expect((await body(res)).reason).toBe('RECENT_DUPLICATE')
    })

    await test.step('completed with ZERO leads → not a duplicate', async () => {
      const search = { location: 'Emptyville, QC', keyword: 'no-leads', radiusKm: 10 }
      await seedCompletedTask(uid, search, 0)
      const res = await create(search)
      expect((await body(res)).reason).not.toBe('RECENT_DUPLICATE')
    })
  })
})
