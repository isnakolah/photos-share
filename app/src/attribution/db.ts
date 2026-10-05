import fs from 'fs'
import path from 'path'
import { DatabaseSync } from 'node:sqlite'

/*
  Upload log: who added which asset, through which share link.

  Immich records guest uploads as owned by the share owner, so this table is
  the source of truth for "who added it". It backs the "Added by" labels on the
  share page, the uploader filter, and the admin page's delete-by-uploader.

  Uses Node's built-in `node:sqlite` so the image needs no native build step.
*/

export interface UploadRecord {
  id: number
  uploadId: string
  assetId: string | null
  uploader: string
  shareKey: string
  albumId: string
  albumName: string
  filename: string
  size: number
  mimeType: string
  ip: string
  userAgent: string
  duplicate: boolean
  status: 'pending' | 'done' | 'error'
  error: string | null
  createdAt: string
  deletedAt: string | null
}

export interface NewUpload {
  uploadId: string
  uploader: string
  shareKey: string
  albumId: string
  albumName: string
  filename: string
  size: number
  mimeType: string
  ip: string
  userAgent: string
}

export interface UploaderSummary {
  uploader: string
  count: number
  bytes: number
  lastUpload: string
}

let db: DatabaseSync | undefined

export function openDb (file = process.env.UPLOAD_DB_PATH || '/data/uploads.db'): DatabaseSync {
  if (db) return db
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true })
  db = new DatabaseSync(file)
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS uploads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      upload_id TEXT NOT NULL UNIQUE,
      asset_id TEXT,
      uploader TEXT NOT NULL,
      share_key TEXT NOT NULL,
      album_id TEXT NOT NULL,
      album_name TEXT NOT NULL DEFAULT '',
      filename TEXT NOT NULL,
      size INTEGER NOT NULL DEFAULT 0,
      mime_type TEXT NOT NULL DEFAULT '',
      ip TEXT NOT NULL DEFAULT '',
      user_agent TEXT NOT NULL DEFAULT '',
      duplicate INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      deleted_at TEXT
    );
    CREATE INDEX IF NOT EXISTS uploads_asset ON uploads (asset_id);
    CREATE INDEX IF NOT EXISTS uploads_uploader ON uploads (uploader);
    CREATE INDEX IF NOT EXISTS uploads_album ON uploads (album_id);
    CREATE TABLE IF NOT EXISTS sessions (
      sid_hash TEXT PRIMARY KEY,
      immich_token TEXT NOT NULL,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      expires_at TEXT NOT NULL
    );
    -- Which share link (invite) leads to which album, so the home page can
    -- link albums shared with a friend (they can't list the owner's links).
    CREATE TABLE IF NOT EXISTS album_links (
      album_id TEXT PRIMARY KEY,
      share_key TEXT NOT NULL,
      slug TEXT,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    -- Legacy (pre-accounts) owner sessions; unused.
    CREATE TABLE IF NOT EXISTS owner_sessions (
      sid_hash TEXT PRIMARY KEY,
      immich_token TEXT NOT NULL,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      expires_at TEXT NOT NULL
    );
  `)
  return db
}

/** Test hook: drop the cached handle so a fresh DB can be opened. */
export function closeDb (): void {
  db?.close()
  db = undefined
}

function row (r: Record<string, unknown>): UploadRecord {
  return {
    id: Number(r.id),
    uploadId: String(r.upload_id),
    assetId: r.asset_id ? String(r.asset_id) : null,
    uploader: String(r.uploader),
    shareKey: String(r.share_key),
    albumId: String(r.album_id),
    albumName: String(r.album_name),
    filename: String(r.filename),
    size: Number(r.size),
    mimeType: String(r.mime_type),
    ip: String(r.ip),
    userAgent: String(r.user_agent),
    duplicate: !!r.duplicate,
    status: r.status as UploadRecord['status'],
    error: r.error ? String(r.error) : null,
    createdAt: String(r.created_at),
    deletedAt: r.deleted_at ? String(r.deleted_at) : null
  }
}

/** Record a finished transfer before it is handed to Immich. Idempotent per uploadId. */
export function recordPending (u: NewUpload): void {
  openDb().prepare(`
    INSERT INTO uploads (upload_id, uploader, share_key, album_id, album_name, filename, size, mime_type, ip, user_agent)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (upload_id) DO NOTHING
  `).run(u.uploadId, u.uploader, u.shareKey, u.albumId, u.albumName, u.filename, u.size, u.mimeType, u.ip, u.userAgent)
}

export function markDone (uploadId: string, assetId: string, duplicate: boolean): void {
  openDb().prepare('UPDATE uploads SET asset_id = ?, duplicate = ?, status = \'done\', error = NULL WHERE upload_id = ?')
    .run(assetId, duplicate ? 1 : 0, uploadId)
}

export function markError (uploadId: string, error: string): void {
  openDb().prepare('UPDATE uploads SET status = \'error\', error = ? WHERE upload_id = ?').run(error.slice(0, 500), uploadId)
}

export function getByUploadIds (uploadIds: string[]): UploadRecord[] {
  if (!uploadIds.length) return []
  const placeholders = uploadIds.map(() => '?').join(',')
  return openDb().prepare(`SELECT * FROM uploads WHERE upload_id IN (${placeholders})`)
    .all(...uploadIds).map(r => row(r as Record<string, unknown>))
}

/**
 * Map asset id -> uploader for the given album. When the same file was added
 * by several people (Immich dedupes it into one asset), the first uploader wins.
 */
export function uploadersForAlbum (albumId: string): Map<string, string> {
  const rows = openDb().prepare(`
    SELECT asset_id, uploader FROM uploads
    WHERE album_id = ? AND asset_id IS NOT NULL AND status = 'done' AND deleted_at IS NULL
    ORDER BY id ASC
  `).all(albumId) as Array<{ asset_id: string, uploader: string }>
  const map = new Map<string, string>()
  for (const r of rows) {
    if (!map.has(r.asset_id)) map.set(r.asset_id, r.uploader)
  }
  return map
}

export function summaryByUploader (): UploaderSummary[] {
  return (openDb().prepare(`
    SELECT uploader, COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes, MAX(created_at) AS last_upload
    FROM uploads WHERE status = 'done' AND deleted_at IS NULL
    GROUP BY uploader ORDER BY last_upload DESC
  `).all() as Array<Record<string, unknown>>).map(r => ({
    uploader: String(r.uploader),
    count: Number(r.count),
    bytes: Number(r.bytes),
    lastUpload: String(r.last_upload)
  }))
}

export function listUploads (opts: { uploader?: string, limit?: number } = {}): UploadRecord[] {
  const limit = opts.limit ?? 500
  const stmt = opts.uploader
    ? openDb().prepare('SELECT * FROM uploads WHERE uploader = ? ORDER BY id DESC LIMIT ?')
    : openDb().prepare('SELECT * FROM uploads ORDER BY id DESC LIMIT ?')
  const rows = opts.uploader ? stmt.all(opts.uploader, limit) : stmt.all(limit)
  return rows.map(r => row(r as Record<string, unknown>))
}

/**
 * Asset ids this uploader actually introduced. Duplicates are excluded: those
 * assets already existed (possibly in the owner's own library), so deleting
 * "everything X uploaded" must never touch them.
 */
export function deletableAssetsFor (uploader: string): string[] {
  return (openDb().prepare(`
    SELECT DISTINCT asset_id FROM uploads
    WHERE uploader = ? AND status = 'done' AND duplicate = 0 AND deleted_at IS NULL AND asset_id IS NOT NULL
  `).all(uploader) as Array<{ asset_id: string }>).map(r => r.asset_id)
}

/** Same as deletableAssetsFor, grouped by album (for removing from albums). */
export function removableByAlbum (uploader: string): Map<string, string[]> {
  const rows = openDb().prepare(`
    SELECT DISTINCT album_id, asset_id FROM uploads
    WHERE uploader = ? AND status = 'done' AND duplicate = 0 AND deleted_at IS NULL AND asset_id IS NOT NULL
  `).all(uploader) as Array<{ album_id: string, asset_id: string }>
  const map = new Map<string, string[]>()
  for (const r of rows) map.set(r.album_id, [...(map.get(r.album_id) || []), r.asset_id])
  return map
}

export function markDeleted (assetIds: string[]): void {
  if (!assetIds.length) return
  const placeholders = assetIds.map(() => '?').join(',')
  openDb().prepare(`UPDATE uploads SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE asset_id IN (${placeholders})`)
    .run(...assetIds)
}

export function isProcessed (uploadId: string): boolean {
  const r = openDb().prepare('SELECT status FROM uploads WHERE upload_id = ?').get(uploadId) as { status?: string } | undefined
  return r?.status === 'done'
}

export function rememberAlbumLink (albumId: string, shareKey: string, slug: string | null | undefined): void {
  openDb().prepare(`
    INSERT INTO album_links (album_id, share_key, slug) VALUES (?, ?, ?)
    ON CONFLICT (album_id) DO UPDATE SET share_key = excluded.share_key, slug = excluded.slug,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `).run(albumId, shareKey, slug || null)
}

export function albumLinks (albumIds: string[]): Map<string, { shareKey: string, slug: string | null }> {
  const map = new Map<string, { shareKey: string, slug: string | null }>()
  if (!albumIds.length) return map
  const rows = openDb().prepare(`SELECT album_id, share_key, slug FROM album_links WHERE album_id IN (${albumIds.map(() => '?').join(',')})`)
    .all(...albumIds) as Array<{ album_id: string, share_key: string, slug: string | null }>
  for (const r of rows) map.set(r.album_id, { shareKey: r.share_key, slug: r.slug })
  return map
}

export function forgetAlbumLink (albumId: string): void {
  openDb().prepare('DELETE FROM album_links WHERE album_id = ?').run(albumId)
}
