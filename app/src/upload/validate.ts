import { decrypt } from '../encrypt'
import { SharedLink } from '../types'

/*
  Pure validation helpers for guest uploads. Kept free of I/O so they are
  straightforward to unit test.
*/

export const MAX_NAME_LENGTH = 40

// Browsers often send an empty or generic type for HEIC and camera RAW files,
// so accept by extension as a fallback. Immich rejects anything it can't read.
const MEDIA_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'avif', 'tif', 'tiff', 'bmp', 'jxl',
  'dng', 'cr2', 'cr3', 'nef', 'arw', 'raf', 'orf', 'rw2', 'srw', 'pef',
  'mov', 'mp4', 'm4v', '3gp', 'avi', 'mkv', 'webm', 'mts', 'm2ts', 'mpg', 'mpeg', 'wmv'
])

/**
 * Normalise a visitor-supplied display name. Returns undefined when nothing
 * usable is left. Slashes are removed because Immich treats them as tag
 * hierarchy separators (`uploader/<name>`).
 */
export function cleanUploaderName (raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const name = raw
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f/\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LENGTH)
    .trim()
  return name || undefined
}

export function isAllowedMedia (filename: string, mimeType: string): boolean {
  if (/^(image|video)\//i.test(mimeType)) return true
  const ext = filename.toLowerCase().split('.').pop() || ''
  return MEDIA_EXTENSIONS.has(ext)
}

/** Strip any path component and control characters from a client filename. */
export function cleanFilename (raw: unknown): string {
  const base = String(raw || '').split(/[\\/]/).pop() || ''
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 255)
  return cleaned || 'upload'
}

/** Parse the client's File.lastModified (ms since epoch) into an ISO date. */
export function fileDate (lastModified: unknown, now = new Date()): string {
  const ms = Number(lastModified)
  // Reject nonsense (before 1990 or more than a day in the future)
  if (!Number.isFinite(ms) || ms < 631152000000 || ms > now.getTime() + 86400000) {
    return now.toISOString()
  }
  return new Date(ms).toISOString()
}

export type UploadGate =
  | { ok: true, albumId: string, albumName: string }
  | { ok: false, status: number, reason: string }

/**
 * Decide whether a resolved share link accepts guest uploads. Only album
 * shares qualify: the upload has to land somewhere friends can see it.
 */
export function uploadGate (link: SharedLink | undefined): UploadGate {
  if (!link) return { ok: false, status: 404, reason: 'Invalid share link' }
  if (!link.allowUpload) return { ok: false, status: 403, reason: 'Uploads are not enabled for this link' }
  if (!link.album?.id) return { ok: false, status: 403, reason: 'Uploads are only supported on album links' }
  return { ok: true, albumId: link.album.id, albumName: link.album.albumName || '' }
}

/**
 * Recover the unlock password for `key` from the raw `Cookie` header. The
 * session cookie (cookie-session) is base64 JSON holding one AES-encrypted
 * payload per share key, written by the password page. The ciphertext is
 * bound to this process's random key, and the password is re-verified by
 * Immich anyway, so reading it without the signature cookie is safe.
 */
export function passwordFromCookie (cookieHeader: string | null | undefined, key: string): string | undefined {
  if (!cookieHeader) return undefined
  const match = cookieHeader.split(/;\s*/).find(c => c.startsWith('session='))
  if (!match) return undefined
  try {
    const session = JSON.parse(Buffer.from(match.slice('session='.length), 'base64').toString('utf8'))
    const entry = session?.[key]
    if (!entry?.iv || !entry?.cr) return undefined
    const payload = JSON.parse(decrypt({ iv: String(entry.iv), cr: String(entry.cr) }))
    if (payload?.expires && new Date(payload.expires) > new Date()) return payload.password
  } catch (e) { }
  return undefined
}

/** Best-effort client IP. Cloudflare sets CF-Connecting-IP on tunnelled requests. */
export function clientIp (headers: { get (name: string): string | null }, fallback = ''): string {
  return headers.get('cf-connecting-ip') ||
    (headers.get('x-forwarded-for') || '').split(',')[0].trim() ||
    fallback
}
