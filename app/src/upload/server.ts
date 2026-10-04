import path from 'path'
import express from 'express'
import { Server } from '@tus/server'
import { FileStore } from '@tus/file-store'
import type { Upload } from '@tus/utils'
import { log } from '../utils/log'
import { getByUploadIds } from '../attribution/db'
import { adminKey } from './immichAdmin'
import { getSession, sessionRef, sidFromCookieHeader } from '../account/session'
import { albumForUser, roleIn } from '../account/access'
import { enqueue, recoverPending, UploadMeta } from './processor'
import { cleanFilename, clientIp, isAllowedMedia } from './validate'

/*
  Uploads over the tus resumable-upload protocol.

  Browsers send 50 MB chunks, which keeps every request under Cloudflare's
  100 MB body limit and lets flaky mobile connections resume where they left
  off. Authorisation happens once, when the upload is created: a signed-in
  account that owns or can edit the album.
*/

export const UPLOAD_PATH = '/share/upload'

export function uploadDir (): string {
  return process.env.UPLOAD_TMP_DIR || '/data/tus'
}

export function maxUploadBytes (): number {
  const n = Number(process.env.UPLOAD_MAX_BYTES)
  return Number.isFinite(n) && n > 0 ? n : 10 * 1024 ** 3
}

export function uploadsEnabled (): boolean {
  return !!adminKey()
}

function reject (status: number, body: string): never {
  // tus-server turns a thrown { status_code, body } into that HTTP response
  // eslint-disable-next-line no-throw-literal
  throw { status_code: status, body }
}

/**
 * Member uploads: a signed-in account adding to an album they own or can
 * edit. Authorised by the session cookie plus an album role check made with
 * that person's own Immich token. Files are later uploaded with that token, so
 * Immich records who added each one.
 */
async function memberUploadMeta (req: { headers: Headers }, upload: Upload): Promise<UploadMeta> {
  const meta = upload.metadata || {}
  const sid = sidFromCookieHeader(req.headers.get('cookie'))
  const account = getSession(sid)
  if (!sid || !account) reject(401, 'Please sign in again')
  const albumId = String(meta.albumId || '')
  if (!/^[0-9a-f-]{36}$/.test(albumId)) reject(400, 'Unknown album')
  const filename = cleanFilename(meta.filename)
  const filetype = String(meta.filetype || '')
  if (!isAllowedMedia(filename, filetype)) reject(415, 'Only photos and videos can be added')
  if (upload.sizeIsDeferred) reject(400, 'File size is required')
  const album = await albumForUser(account!, albumId)
  const role = roleIn(album, account!.userId)
  if (role !== 'owner' && role !== 'editor') reject(403, 'You can view this album but not add to it')
  return {
    mode: 'member',
    accountRef: sessionRef(sid as string),
    albumId,
    albumName: album!.albumName,
    uploader: account!.name,
    filename,
    filetype,
    lastModified: String(meta.lastModified || ''),
    ip: clientIp(req.headers),
    userAgent: (req.headers.get('user-agent') || '').slice(0, 300)
  }
}

export function createTusServer (): Server {
  const directory = uploadDir()
  const datastore = new FileStore({
    directory,
    expirationPeriodInMilliseconds: 24 * 60 * 60 * 1000
  })

  const server = new Server({
    path: UPLOAD_PATH,
    datastore,
    relativeLocation: true,
    maxSize: maxUploadBytes(),

    async onUploadCreate (req, upload: Upload) {
      if (!uploadsEnabled()) reject(503, 'Uploads are not configured on this server')
      // Everything stored is server-decided; nothing else the client sent survives.
      return { metadata: await memberUploadMeta(req, upload) as unknown as Record<string, string> }
    },

    async onUploadFinish (_req, upload: Upload) {
      enqueue({
        uploadId: upload.id,
        filePath: path.join(directory, upload.id),
        size: upload.size || upload.offset,
        meta: upload.metadata as unknown as UploadMeta
      })
      return {}
    }
  })

  // Drop abandoned partial uploads once they pass the expiry window.
  setInterval(() => {
    server.cleanUpExpiredUploads()
      .then(n => { if (n) log('Removed ' + n + ' expired partial uploads') })
      .catch(e => log.warn('Expired upload cleanup failed: ' + e))
  }, 60 * 60 * 1000).unref()

  recoverPending(directory)
  return server
}

/**
 * Mount the tus endpoint plus the status route. Must be registered before any
 * body-parsing middleware so the raw chunk stream reaches tus untouched.
 */
export function mountUploads (app: express.Express): void {
  if (!uploadsEnabled()) {
    log('IMMICH_API_KEY not set - uploads are disabled')
    return
  }
  const tus = createTusServer()
  app.all([UPLOAD_PATH, UPLOAD_PATH + '/*'], (req, res, next) => {
    if (req.path === UPLOAD_PATH + '/status') return next()
    tus.handle(req, res).catch(next)
  })

  // Browser polls this after the transfer to learn when Immich has the file.
  app.get(UPLOAD_PATH + '/status', (req, res) => {
    const ids = String(req.query.ids || '').split(',').filter(id => /^[0-9a-f]{16,64}$/i.test(id)).slice(0, 200)
    const found = new Map(getByUploadIds(ids).map(r => [r.uploadId, r]))
    res.set('Cache-Control', 'no-store')
    res.json(ids.map(id => {
      const r = found.get(id)
      return {
        id,
        status: r?.status || 'pending',
        duplicate: r?.duplicate || false,
        error: r?.status === 'error' ? 'Could not save this file' : undefined
      }
    }))
  })
  log('Uploads enabled (max ' + Math.round(maxUploadBytes() / 1024 ** 2) + ' MB per file, temp dir ' + uploadDir() + ')')
}
