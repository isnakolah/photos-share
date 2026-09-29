import fs from 'fs'
import path from 'path'
import { invalidateAllShares, invalidateShare } from '../immich'
import { getSessionByRef } from '../owner/session'
import { log } from '../utils/log'
import { isProcessed, markDone, markError, recordPending } from '../attribution/db'
import { addToAlbum, getAsset, ImmichAuth, setDescription, tagAsset, uploadAsset } from './immichAdmin'
import { fileDate } from './validate'

/*
  Hands finished tus uploads to Immich in the background.

  The last PATCH of a tus upload returns as soon as the bytes are on disk.
  Pushing a multi-GB video into Immich can take longer than Cloudflare's 100s
  origin timeout, so that work happens here and the browser polls
  /share/upload/status for the outcome.
*/

export interface UploadMeta {
  // 'share': guest via a share link. 'owner': signed-in album owner.
  mode: 'share' | 'owner'
  // Owner mode: hash of the owner's session id, to look up their token
  ownerRef: string
  shareKey: string
  shareSlug: string
  albumId: string
  albumName: string
  uploader: string
  filename: string
  filetype: string
  lastModified: string
  ip: string
  userAgent: string
}

export interface Job {
  uploadId: string
  filePath: string
  size: number
  meta: UploadMeta
}

const CONCURRENCY = 2
const MAX_ATTEMPTS = 3
const queue: Job[] = []
const queued = new Set<string>()
let running = 0

export function enqueue (job: Job): void {
  if (queued.has(job.uploadId)) return
  recordPending({
    uploadId: job.uploadId,
    uploader: job.meta.uploader,
    shareKey: job.meta.shareKey,
    albumId: job.meta.albumId,
    albumName: job.meta.albumName,
    filename: job.meta.filename,
    size: job.size,
    mimeType: job.meta.filetype,
    ip: job.meta.ip,
    userAgent: job.meta.userAgent
  })
  queued.add(job.uploadId)
  queue.push(job)
  pump()
}

function pump (): void {
  while (running < CONCURRENCY && queue.length) {
    const job = queue.shift() as Job
    running++
    run(job)
      .catch(e => log.error('Upload job crashed: ' + e))
      .finally(() => {
        running--
        queued.delete(job.uploadId)
        pump()
      })
  }
}

async function run (job: Job): Promise<void> {
  let lastError = ''
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await processJob(job)
      return
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
      log.warn(`Upload ${job.uploadId} attempt ${attempt} failed: ${lastError}`)
      await new Promise(resolve => setTimeout(resolve, attempt * 3000))
    }
  }
  markError(job.uploadId, lastError)
  log.error(`Upload ${job.uploadId} (${job.meta.filename} from ${job.meta.uploader}) gave up: ${lastError}`)
}

export async function processJob (job: Job): Promise<void> {
  const { meta } = job
  const owner = meta.mode === 'owner'
  let auth: ImmichAuth | undefined
  if (owner) {
    const session = getSessionByRef(meta.ownerRef)
    if (!session) throw new Error('Owner session expired before the upload was saved')
    auth = { bearer: session.token }
  }
  const result = await uploadAsset(job.filePath, {
    filename: meta.filename,
    mimeType: meta.filetype,
    fileCreatedAt: fileDate(meta.lastModified)
  }, auth)
  // Uploading doesn't touch any album; add it explicitly.
  // Already-in-album comes back as a per-id error, which is fine.
  await addToAlbum(meta.albumId, [result.id], auth)

  const duplicate = result.status === 'duplicate'
  // The owner's own photos need no "Added by" stamp: Immich already knows
  // they're theirs, and the gallery falls back to OWNER_NAME.
  if (!owner) await attribute(result.id, meta.uploader, duplicate)
  markDone(job.uploadId, result.id, duplicate)
  if (owner) invalidateAllShares()
  else invalidateShare(meta.shareKey, meta.shareSlug)
  log(`Upload ${meta.filename} from ${meta.uploader} -> asset ${result.id}${duplicate ? ' (duplicate)' : ''}`)
  removeFiles(job.filePath)
}

/**
 * Stamp who added the asset into Immich itself: a description line and an
 * `uploader/<name>` tag. Failures here are logged but don't fail the upload;
 * the SQLite log still has the attribution.
 */
async function attribute (assetId: string, uploader: string, duplicate: boolean): Promise<void> {
  const line = 'Added by ' + uploader
  try {
    const asset = await getAsset(assetId)
    const existing = (asset.exifInfo?.description || '').trim()
    // A duplicate already has an owner story (possibly the host's own photo),
    // so only fill in the description when it's empty.
    if (!existing) {
      await setDescription(assetId, line)
    } else if (!duplicate && !existing.includes('Added by ')) {
      await setDescription(assetId, existing + '\n\n' + line)
    }
  } catch (e) {
    log.warn('Could not set description on ' + assetId + ': ' + e)
  }
  try {
    await tagAsset(assetId, 'uploader/' + uploader)
  } catch (e) {
    log.warn('Could not tag ' + assetId + ': ' + e)
  }
}

function removeFiles (filePath: string): void {
  for (const f of [filePath, filePath + '.json']) {
    fs.rm(f, { force: true }, () => {})
  }
}

/**
 * After a restart, re-queue uploads that finished transferring but never made
 * it into Immich. FileStore keeps `<id>` (bytes) and `<id>.json` (metadata)
 * side by side.
 */
export function recoverPending (directory: string): void {
  let entries: string[] = []
  try {
    entries = fs.readdirSync(directory).filter(f => f.endsWith('.json'))
  } catch (e) {
    return
  }
  for (const file of entries) {
    try {
      const info = JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'))
      const id = String(info.id)
      const filePath = path.join(directory, id)
      if (!fs.existsSync(filePath)) continue
      const size = fs.statSync(filePath).size
      if (typeof info.size !== 'number' || size !== info.size) continue
      if (isProcessed(id)) {
        removeFiles(filePath)
        continue
      }
      log('Recovering finished upload ' + id)
      enqueue({ uploadId: id, filePath, size, meta: info.metadata as UploadMeta })
    } catch (e) {
      log.warn('Skipping unreadable upload record ' + file + ': ' + e)
    }
  }
}
