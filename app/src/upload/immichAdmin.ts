import fs from 'fs'
import { apiUrl } from '../immich'

/*
  Immich calls made on the server's behalf. By default they use the host's
  API key (IMMICH_API_KEY). It belongs to the Immich admin who owns the albums
  and needs: adminUser.create (sign-ups), albumUser.create (adding members),
  albumAsset.delete (admin page), asset.delete, album.read, sharedLink.read.

  Calls on behalf of a signed-in person pass their access token (`auth`).
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

/** Take assets out of an album (the files stay in their owners' libraries). */
export function removeFromAlbum (albumId: string, assetIds: string[]) {
  return immichCall<unknown>('DELETE', `/albums/${albumId}/assets`, { ids: assetIds })
}

/** Move assets to Immich's trash (recoverable from the Immich UI). */
export function trashAssets (assetIds: string[]) {
  return immichCall<unknown>('DELETE', '/assets', { ids: assetIds, force: false })
}
