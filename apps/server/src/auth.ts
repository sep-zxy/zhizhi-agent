import crypto from 'node:crypto'
import { SignJWT, jwtVerify } from 'jose'
import { eq } from 'drizzle-orm'
import { asBrand, mintUserId, type UserId } from '@zhizhi/brand'
import type { TenantContext } from '@zhizhi/contracts'
import { userMemories, users, type DatabaseHandle } from '@zhizhi/db'
import { ZhizhiError } from '@zhizhi/errors'

const SCRYPT_KEYLEN = 64

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex')
  const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex')
  return `${salt}:${derived}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(':')
  const salt = parts[0]
  const expectedHex = parts[1]
  if (!salt || !expectedHex) return false
  const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN)
  const expected = Buffer.from(expectedHex, 'hex')
  if (derived.length !== expected.length) return false
  return crypto.timingSafeEqual(derived, expected)
}

export async function signAccessToken(tenant: TenantContext, secret: string): Promise<string> {
  const key = new TextEncoder().encode(secret)
  return new SignJWT({ role: tenant.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(tenant.userId)
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(key)
}

export async function verifyAccessToken(token: string, secret: string): Promise<TenantContext> {
  const key = new TextEncoder().encode(secret)
  try {
    const { payload } = await jwtVerify(token, key)
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
      throw new ZhizhiError({ code: 'UNAUTHORIZED', message: 'Invalid token subject' })
    }
    const role = payload['role'] === 'admin' ? 'admin' : 'user'
    return { userId: asBrand<UserId>(payload.sub), role }
  } catch (err) {
    if (err instanceof ZhizhiError) throw err
    throw new ZhizhiError({ code: 'UNAUTHORIZED', message: 'Invalid or expired access token', cause: err })
  }
}

export async function registerUser(
  dbHandle: DatabaseHandle,
  input: { readonly email: string; readonly displayName: string; readonly password: string },
): Promise<{ readonly userId: UserId; readonly email: string; readonly displayName: string }> {
  const email = input.email.trim().toLowerCase()
  const existing = await dbHandle.db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1)
  if (existing[0]) {
    throw new ZhizhiError({ code: 'CONFLICT', message: `Email "${email}" is already registered` })
  }

  const userId = mintUserId()
  await dbHandle.db.insert(users).values({
    id: userId,
    email,
    displayName: input.displayName.trim(),
    passwordHash: hashPassword(input.password),
    role: 'user',
  })
  await dbHandle.db.insert(userMemories).values({ userId })

  return { userId, email, displayName: input.displayName.trim() }
}

export async function authenticateUser(
  dbHandle: DatabaseHandle,
  emailRaw: string,
  password: string,
): Promise<{ readonly tenant: TenantContext; readonly displayName: string }> {
  const email = emailRaw.trim().toLowerCase()
  const rows = await dbHandle.db.select().from(users).where(eq(users.email, email)).limit(1)
  const user = rows[0]
  if (!user || !verifyPassword(password, user.passwordHash)) {
    throw new ZhizhiError({ code: 'UNAUTHORIZED', message: 'Invalid email or password' })
  }
  const role = user.role === 'admin' ? 'admin' : 'user'
  return {
    tenant: { userId: asBrand<UserId>(user.id), role },
    displayName: user.displayName,
  }
}
