import crypto from 'node:crypto'

/** Decode a base32 (RFC 4648, no padding) secret into raw bytes. */
function base32Decode(secret: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  const clean = secret.replace(/=+$/, '').toUpperCase().replace(/\s+/g, '')
  let bits = ''
  for (const c of clean) {
    const v = alphabet.indexOf(c)
    if (v < 0) continue
    bits += v.toString(2).padStart(5, '0')
  }
  const bytes: number[] = []
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2))
  return Buffer.from(bytes)
}

/**
 * Compute a TOTP code (RFC 6238) for a base32 secret. Defaults match how most
 * authenticator apps and @fonderie/auth are configured: SHA-1, 6 digits, 30s.
 */
export function totp(secret: string, atMs: number = Date.now(), step = 30, digits = 6): string {
  const key = base32Decode(secret)
  const counter = Math.floor(atMs / 1000 / step)
  const buf = Buffer.alloc(8)
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0)
  buf.writeUInt32BE(counter >>> 0, 4)
  const hmac = crypto.createHmac('sha1', key).update(buf).digest()
  const offset = hmac[hmac.length - 1] & 0xf
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff)
  return String(code % 10 ** digits).padStart(digits, '0')
}
