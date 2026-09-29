import fs from 'fs'
import { apiUrl } from '../immich'

/*
  Calls made with the operator's Immich API key (IMMICH_API_KEY), never with a
  visitor's share key. The key must belong to the album owner and needs:
    asset.upload, asset.read, asset.update, asset.delete,
    album.read, albumAsset.create, sharedLink.read, tag.create, tag.asset
*/

export function adminKey (): string | undefined {
  return process.env.IMMICH_API_KEY || undefined
}

async function call<T> (method: string, endpoint: string, body?: unknown): Promise<T> {
  const key = adminKey()
  if (!key) throw new Error('IMMICH_API_KEY is not set')
  const res = await fetch(apiUrl() + endpoint, {
    method,
    headers: {
      'x-api-key': key,
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Immich ${method} ${endpoint} -> ${res.status}: ${text.slice(0, 300)}`)
  return (text ? JSON.parse(text) : undefined) as T
}

export interface UploadResult {
  id: string
  status: 'created' | 'duplicate'
}

/**
 * Stream a finished file into Immich. `fs.openAsBlob` gives a lazily-read,
 * file-backed Blob, so multi-GB videos are never held in memory.
 */
export async function uploadAsset (filePath: string, opts: {
  filename: string
  mimeType: string
  fileCreatedAt: string
}): Promise<UploadResult> {
  const key = adminKey()
  if (!key) throw new Error('IMMICH_API_KEY is not set')
  const blob = await fs.openAsBlob(filePath, { type: opts.mimeType || 'application/octet-stream' })
  const form = new FormData()
  form.append('fileCreatedAt', opts.fileCreatedAt)
  form.append('fileModifiedAt', opts.fileCreatedAt)
  form.append('filename', opts.filename)
  form.append('assetData', blob, opts.filename)
  const res = await fetch(apiUrl() + '/assets', {
    method: 'POST',
    headers: { 'x-api-key': key, Accept: 'application/json' },
    body: form
  })
  const text = await res.text()
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`Immich upload -> ${res.status}: ${text.slice(0, 300)}`)
  }
  return JSON.parse(text) as UploadResult
}

export function addToAlbum (albumId: string, assetIds: string[]) {
  return call<Array<{ id: string, success: boolean, error?: string }>>('PUT', `/albums/${albumId}/assets`, { ids: assetIds })
}

export function getAsset (assetId: string) {
  return call<{ id: string, exifInfo?: { description?: string | null } }>('GET', `/assets/${assetId}`)
}

export function setDescription (assetId: string, description: string) {
  return call<unknown>('PUT', `/assets/${assetId}`, { description })
}

export async function tagAsset (assetId: string, tagValue: string): Promise<void> {
  const tags = await call<Array<{ id: string, value: string }>>('PUT', '/tags', { tags: [tagValue] })
  const tag = tags.find(t => t.value === tagValue) || tags[tags.length - 1]
  if (!tag) throw new Error('Tag upsert returned nothing for ' + tagValue)
  await call<unknown>('PUT', '/tags/assets', { tagIds: [tag.id], assetIds: [assetId] })
}

/** Move assets to Immich's trash (recoverable from the Immich UI). */
export function trashAssets (assetIds: string[]) {
  return call<unknown>('DELETE', '/assets', { ids: assetIds, force: false })
}
