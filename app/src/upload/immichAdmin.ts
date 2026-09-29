import fs from 'fs'
import { apiUrl } from '../immich'

/*
  Immich calls made on the server's behalf. By default they use the
  operator's API key (IMMICH_API_KEY), never a visitor's share key. The key
  must belong to the album owner and needs:
    asset.upload, asset.read, asset.update, asset.delete,
    album.read, albumAsset.create, sharedLink.read, tag.create, tag.asset

  Owner-mode calls pass a signed-in user's access token instead (`auth`).
*/

export type ImmichAuth = { apiKey: string } | { bearer: string }

export function adminKey (): string | undefined {
  return process.env.IMMICH_API_KEY || undefined
}

function authHeaders (auth?: ImmichAuth): Record<string, string> {
  if (auth && 'bearer' in auth) return { Authorization: 'Bearer ' + auth.bearer }
  const key = auth?.apiKey || adminKey()
  if (!key) throw new Error('IMMICH_API_KEY is not set')
  return { 'x-api-key': key }
}

export async function immichCall<T> (method: string, endpoint: string, body?: unknown, auth?: ImmichAuth): Promise<T> {
  const res = await fetch(apiUrl() + endpoint, {
    method,
    headers: {
      ...authHeaders(auth),
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  })
  const text = await res.text()
  if (!res.ok) {
    const err = new Error(`Immich ${method} ${endpoint} -> ${res.status}: ${text.slice(0, 300)}`) as Error & { status?: number }
    err.status = res.status
    throw err
  }
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
}, auth?: ImmichAuth): Promise<UploadResult> {
  const blob = await fs.openAsBlob(filePath, { type: opts.mimeType || 'application/octet-stream' })
  const form = new FormData()
  form.append('fileCreatedAt', opts.fileCreatedAt)
  form.append('fileModifiedAt', opts.fileCreatedAt)
  form.append('filename', opts.filename)
  form.append('assetData', blob, opts.filename)
  const res = await fetch(apiUrl() + '/assets', {
    method: 'POST',
    headers: { ...authHeaders(auth), Accept: 'application/json' },
    body: form
  })
  const text = await res.text()
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`Immich upload -> ${res.status}: ${text.slice(0, 300)}`)
  }
  return JSON.parse(text) as UploadResult
}

export function addToAlbum (albumId: string, assetIds: string[], auth?: ImmichAuth) {
  return immichCall<Array<{ id: string, success: boolean, error?: string }>>('PUT', `/albums/${albumId}/assets`, { ids: assetIds }, auth)
}

export function getAsset (assetId: string) {
  return immichCall<{ id: string, exifInfo?: { description?: string | null } }>('GET', `/assets/${assetId}`)
}

export function setDescription (assetId: string, description: string) {
  return immichCall<unknown>('PUT', `/assets/${assetId}`, { description })
}

export async function tagAsset (assetId: string, tagValue: string): Promise<void> {
  const tags = await immichCall<Array<{ id: string, value: string }>>('PUT', '/tags', { tags: [tagValue] })
  const tag = tags.find(t => t.value === tagValue) || tags[tags.length - 1]
  if (!tag) throw new Error('Tag upsert returned nothing for ' + tagValue)
  await immichCall<unknown>('PUT', '/tags/assets', { tagIds: [tag.id], assetIds: [assetId] })
}

/** Move assets to Immich's trash (recoverable from the Immich UI). */
export function trashAssets (assetIds: string[]) {
  return immichCall<unknown>('DELETE', '/assets', { ids: assetIds, force: false })
}
