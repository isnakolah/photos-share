import crypto from 'crypto'
import { openDb } from '../attribution/db'

/*
  Owner sessions: a signed-in Immich user managing their albums from the
  public app. The browser holds only a random session id (HttpOnly cookie);
  the Immich access token stays server-side in SQLite, keyed by the id's hash.
*/

export const COOKIE_NAME = 'owner_sid'
const TTL_DAYS = 30

export interface OwnerSession {
  token: string
  userId: string
  name: string
  email: string
}

const hash = (sid: string) => crypto.createHash('sha256').update(sid).digest('hex')

export function createSession (s: OwnerSession): { sid: string, maxAgeMs: number } {
  const sid = crypto.randomBytes(32).toString('base64url')
  const expires = new Date(Date.now() + TTL_DAYS * 86400e3).toISOString()
  openDb().prepare(`
    INSERT INTO owner_sessions (sid_hash, immich_token, user_id, name, email, expires_at) VALUES (?, ?, ?, ?, ?, ?)
  `).run(hash(sid), s.token, s.userId, s.name, s.email, expires)
  return { sid, maxAgeMs: TTL_DAYS * 86400e3 }
}

export function getSession (sid: string | undefined): OwnerSession | undefined {
  if (!sid || sid.length > 100) return undefined
  const row = openDb().prepare(`
    SELECT immich_token, user_id, name, email FROM owner_sessions
    WHERE sid_hash = ? AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `).get(hash(sid)) as Record<string, string> | undefined
  if (!row) return undefined
  return { token: row.immich_token, userId: row.user_id, name: row.name, email: row.email }
}

/** Hash of a session id, safe to persist (e.g. in tus upload metadata). */
export function sessionRef (sid: string): string {
  return hash(sid)
}

export function getSessionByRef (ref: string): OwnerSession | undefined {
  const row = openDb().prepare(`
    SELECT immich_token, user_id, name, email FROM owner_sessions
    WHERE sid_hash = ? AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `).get(ref) as Record<string, string> | undefined
  if (!row) return undefined
  return { token: row.immich_token, userId: row.user_id, name: row.name, email: row.email }
}

export function deleteSession (sid: string | undefined): OwnerSession | undefined {
  const session = getSession(sid)
  if (sid) openDb().prepare('DELETE FROM owner_sessions WHERE sid_hash = ?').run(hash(sid))
  openDb().prepare('DELETE FROM owner_sessions WHERE expires_at <= strftime(\'%Y-%m-%dT%H:%M:%fZ\', \'now\')').run()
  return session
}

export function sidFromCookieHeader (cookieHeader: string | null | undefined): string | undefined {
  if (!cookieHeader) return undefined
  const match = cookieHeader.split(/;\s*/).find(c => c.startsWith(COOKIE_NAME + '='))
  return match ? decodeURIComponent(match.slice(COOKIE_NAME.length + 1)) : undefined
}

/*
  Login throttling. Per IP: 5 failures per 15 minutes. Globally: 30 failures
  per hour, which caps password guessing from many addresses at once.
*/
const WINDOW_MS = 15 * 60e3
const PER_IP = 5
const GLOBAL_WINDOW_MS = 60 * 60e3
const GLOBAL_MAX = 30
const failures = new Map<string, number[]>()
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

export function resetLoginThrottle (): void {
  failures.clear()
  globalFailures = []
}
