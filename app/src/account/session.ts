import crypto from 'crypto'
import { openDb } from '../attribution/db'

/*
  Account sessions. Everyone signs in with their Immich account: the host
  (an Immich admin) and friends (Immich users created when they accept an
  invite). The browser holds only a random session id in an HttpOnly cookie;
  the Immich access token stays server-side in SQLite, keyed by the id's hash.
*/

export const COOKIE_NAME = 'photos_sid'
const TTL_DAYS = 30

export interface Account {
  token: string
  userId: string
  name: string
  email: string
  isAdmin: boolean
}

const hash = (sid: string) => crypto.createHash('sha256').update(sid).digest('hex')

export function createSession (a: Account): { sid: string, maxAgeMs: number } {
  const sid = crypto.randomBytes(32).toString('base64url')
  const expires = new Date(Date.now() + TTL_DAYS * 86400e3).toISOString()
  openDb().prepare(`
    INSERT INTO sessions (sid_hash, immich_token, user_id, name, email, is_admin, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(hash(sid), a.token, a.userId, a.name, a.email, a.isAdmin ? 1 : 0, expires)
  return { sid, maxAgeMs: TTL_DAYS * 86400e3 }
}

function byRef (ref: string): Account | undefined {
  const row = openDb().prepare(`
    SELECT immich_token, user_id, name, email, is_admin FROM sessions
    WHERE sid_hash = ? AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `).get(ref) as Record<string, string | number> | undefined
  if (!row) return undefined
  return {
    token: String(row.immich_token),
    userId: String(row.user_id),
    name: String(row.name),
    email: String(row.email),
    isAdmin: !!row.is_admin
  }
}

export function getSession (sid: string | undefined): Account | undefined {
  if (!sid || sid.length > 100) return undefined
  return byRef(hash(sid))
}

/** Hash of a session id, safe to persist (e.g. in tus upload metadata). */
export function sessionRef (sid: string): string {
  return hash(sid)
}

export function getSessionByRef (ref: string): Account | undefined {
  return byRef(ref)
}

export function deleteSession (sid: string | undefined): Account | undefined {
  const session = getSession(sid)
  if (sid) openDb().prepare('DELETE FROM sessions WHERE sid_hash = ?').run(hash(sid))
  openDb().prepare('DELETE FROM sessions WHERE expires_at <= strftime(\'%Y-%m-%dT%H:%M:%fZ\', \'now\')').run()
  return session
}

export function sidFromCookieHeader (cookieHeader: string | null | undefined): string | undefined {
  if (!cookieHeader) return undefined
  const match = cookieHeader.split(/;\s*/).find(c => c.startsWith(COOKIE_NAME + '='))
  return match ? decodeURIComponent(match.slice(COOKIE_NAME.length + 1)) : undefined
}

/*
  Throttling for sign-in and sign-up. Per IP: 5 failures per 15 minutes.
  Globally: 30 failures per hour, which caps guessing from many addresses.
  Sign-ups are limited separately: 5 accounts per IP per day.
*/
const WINDOW_MS = 15 * 60e3
const PER_IP = 5
const GLOBAL_WINDOW_MS = 60 * 60e3
const GLOBAL_MAX = 30
const SIGNUP_WINDOW_MS = 24 * 60 * 60e3
const SIGNUPS_PER_IP = 5
const failures = new Map<string, number[]>()
const signups = new Map<string, number[]>()
let globalFailures: number[] = []

export function loginAllowed (ip: string, now = Date.now()): boolean {
  globalFailures = globalFailures.filter(t => now - t < GLOBAL_WINDOW_MS)
  const mine = (failures.get(ip) || []).filter(t => now - t < WINDOW_MS)
  failures.set(ip, mine)
  return mine.length < PER_IP && globalFailures.length < GLOBAL_MAX
}

export function recordLoginFailure (ip: string, now = Date.now()): void {
  failures.set(ip, [...(failures.get(ip) || []), now])
  globalFailures.push(now)
}

export function signupAllowed (ip: string, now = Date.now()): boolean {
  const mine = (signups.get(ip) || []).filter(t => now - t < SIGNUP_WINDOW_MS)
  signups.set(ip, mine)
  return mine.length < SIGNUPS_PER_IP
}

export function recordSignup (ip: string, now = Date.now()): void {
  signups.set(ip, [...(signups.get(ip) || []), now])
}

export function resetLoginThrottle (): void {
  failures.clear()
  signups.clear()
  globalFailures = []
}
