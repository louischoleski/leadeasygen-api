import { expect, test, type APIRequestContext } from '@playwright/test'
import { getEmailVerificationPin, getMfaSecret, hasDbUrl } from './helpers/db'
import { totp } from './helpers/totp'

/**
 * MFA lifecycle at the API level. MFA can't be driven through the app UI — the
 * enrolment secret is only ever shown as a QR code — so this exercises the
 * endpoints directly and computes the TOTP itself.
 *
 *   register -> verify email -> mfa/setup -> mfa/verify (enable) ->
 *   login now demands MFA -> regenerate backup codes -> mfa/disable ->
 *   login is normal again.
 *
 * Reads the emailed pin and the MFA secret straight from the DB (values never
 * returned over the wire). Needs the api running and DATABASE_URL reachable;
 * skips otherwise.
 */

const PASSWORD = 'TestPassw0rd!2026'

async function body(res: { json: () => Promise<unknown> }): Promise<any> {
  return res.json()
}

/** Submit a TOTP-bearing request, retrying once across a 30s-window boundary. */
async function postWithTotp(
  request: APIRequestContext,
  url: string,
  secret: string,
  accessToken: string,
): Promise<any> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await request.post(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      data: { token: totp(secret) },
    })
    const json = await body(res)
    if (res.ok()) return json
    // Only a rejected code is worth retrying; anything else is a real failure.
    if (attempt === 0) {
      await new Promise((r) => setTimeout(r, 1500))
      continue
    }
    throw new Error(`${url} failed: ${res.status()} ${JSON.stringify(json)}`)
  }
}

test.describe('MFA lifecycle (API)', () => {
  test.skip(!hasDbUrl(), 'DATABASE_URL / E2E_DATABASE_URL not set')
  test.describe.configure({ mode: 'serial' })

  test('enable via TOTP, gate login, regenerate backup codes, disable', async ({ request }) => {
    test.setTimeout(60_000)
    const email = `mfa-${Date.now()}@leadeasygen.dev`
    let access = ''

    await test.step('register', async () => {
      const res = await request.post('/auth/register', {
        data: { email, password: PASSWORD, firstName: 'Mel', lastName: 'Factor' },
      })
      expect(res.ok()).toBeTruthy()
      access = (await body(res)).result.tokens.access
      expect(access).toBeTruthy()
    })

    await test.step('verify email (pin from DB)', async () => {
      const pin = await getEmailVerificationPin(email)
      const res = await request.post('/auth/verify', {
        headers: { Authorization: `Bearer ${access}` },
        data: { token: pin },
      })
      expect((await body(res)).reason).toBe('VERIFIED')
      // Re-login so the token unambiguously reflects the now-verified account.
      const login = await request.post('/auth/login', { data: { email, password: PASSWORD } })
      access = (await body(login)).result.tokens.access
    })

    await test.step('mfa/setup returns a QR and backup codes', async () => {
      const res = await request.post('/auth/mfa/setup', {
        headers: { Authorization: `Bearer ${access}` },
      })
      const json = await body(res)
      expect(json.reason).toBe('MFA_SETUP_INITIATED')
      expect(json.result.qr).toMatch(/^data:image\/png;base64,/)
      expect(Array.isArray(json.result.backupCodes)).toBeTruthy()
    })

    await test.step('mfa/verify enables MFA', async () => {
      const secret = await getMfaSecret(email, 'pending')
      const json = await postWithTotp(request, '/auth/mfa/verify', secret, access)
      expect(json.reason).toBe('MFA_VERIFIED')
      expect(json.result.mfaEnabled).toBe(true)
    })

    await test.step('login now requires MFA', async () => {
      const res = await request.post('/auth/login', { data: { email, password: PASSWORD } })
      const json = await body(res)
      expect(json.reason).toBe('MFA_REQUIRED')
      expect(json.result.mfaToken).toBeTruthy()
    })

    await test.step('regenerate backup codes with a TOTP', async () => {
      const secret = await getMfaSecret(email, 'active')
      const json = await postWithTotp(request, '/auth/mfa/backup-codes', secret, access)
      expect(Array.isArray(json.result.backupCodes)).toBeTruthy()
      expect(json.result.backupCodes.length).toBeGreaterThan(0)
    })

    await test.step('mfa/disable turns MFA off', async () => {
      const secret = await getMfaSecret(email, 'active')
      const json = await postWithTotp(request, '/auth/mfa/disable', secret, access)
      expect(json.reason).toBe('MFA_DISABLED')
    })

    await test.step('login is normal again', async () => {
      const res = await request.post('/auth/login', { data: { email, password: PASSWORD } })
      expect((await body(res)).reason).toBe('USER_EMAIL_LOGIN')
    })
  })
})
