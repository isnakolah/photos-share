import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { closeDb, getByUploadIds, openDb, recordPending } from '../src/attribution/db'
import { createSession, sessionRef } from '../src/account/session'
import { processJob, UploadMeta } from '../src/upload/processor'

interface Call { method: string, url: string, body?: unknown, headers: Record<string, string> }

function mockImmich (status: 'created' | 'duplicate' = 'created') {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method || 'GET'
    const headers = init.headers as Record<string, string>
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body
    calls.push({ method, url: url.replace('http://immich/api', ''), body, headers })
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'Content-Type': 'application/json' } })
    if (method === 'POST' && url.endsWith('/assets')) return json({ id: 'asset-1', status })
    if (method === 'PUT' && url.includes('/albums/')) return json([{ id: 'asset-1', success: true }])
    return new Response('not mocked', { status: 500 })
  }))
  return calls
}

describe('processJob (member uploads)', () => {
  let dir: string
  let file: string
  let meta: UploadMeta

  beforeEach(() => {
    process.env.IMMICH_URL = 'http://immich'
    process.env.IMMICH_API_KEY = 'host-key'
    closeDb()
    openDb(':memory:')
    const { sid } = createSession({ token: 'amina-token', userId: 'u-amina', name: 'Amina', email: 'a@example.com', isAdmin: false })
    meta = {
      mode: 'member',
      accountRef: sessionRef(sid),
      albumId: 'album-1',
      albumName: 'Beach',
      uploader: 'Amina',
      filename: 'IMG_1.HEIC',
      filetype: 'image/heic',
      lastModified: String(Date.parse('2026-08-01T10:00:00Z')),
      ip: '1.2.3.4',
      userAgent: 'test'
    }
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tus-'))
    file = path.join(dir, 'up1')
    fs.writeFileSync(file, 'fake image bytes')
    fs.writeFileSync(file + '.json', '{}')
    recordPending({ uploadId: 'up1', uploader: 'Amina', shareKey: '', albumId: 'album-1', albumName: 'Beach', filename: 'IMG_1.HEIC', size: 16, mimeType: 'image/heic', ip: '', userAgent: '' })
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('uploads with the uploader\'s own token, adds to the album, and cleans up', async () => {
    const calls = mockImmich()
    await processJob({ uploadId: 'up1', filePath: file, size: 16, meta })

    const upload = calls.find(c => c.method === 'POST')!
    expect(upload.url).toBe('/assets')
    expect(upload.headers.Authorization).toBe('Bearer amina-token')
    expect(upload.headers['x-api-key']).toBeUndefined()
    const form = upload.body as FormData
    expect(form.get('fileCreatedAt')).toBe('2026-08-01T10:00:00.000Z')
    expect((form.get('assetData') as File).name).toBe('IMG_1.HEIC')

    expect(calls).toContainEqual(expect.objectContaining({ method: 'PUT', url: '/albums/album-1/assets', body: { ids: ['asset-1'] } }))
    // Ownership is the attribution now: no description or tag writes
    expect(calls.some(c => c.url.startsWith('/tags') || c.url === '/assets/asset-1')).toBe(false)

    expect(getByUploadIds(['up1'])[0]).toMatchObject({ status: 'done', assetId: 'asset-1', duplicate: false })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(fs.existsSync(file)).toBe(false)
    expect(fs.existsSync(file + '.json')).toBe(false)
  })

  it('records duplicates', async () => {
    mockImmich('duplicate')
    await processJob({ uploadId: 'up1', filePath: file, size: 16, meta })
    expect(getByUploadIds(['up1'])[0]).toMatchObject({ status: 'done', duplicate: true })
  })

  it('fails (so the queue retries, then reports) when the session is gone', async () => {
    mockImmich()
    await expect(processJob({ uploadId: 'up1', filePath: file, size: 16, meta: { ...meta, accountRef: 'nope' } })).rejects.toThrow(/Signed out/)
    expect(fs.existsSync(file)).toBe(true)
  })

  it('throws when Immich rejects the upload', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })))
    await expect(processJob({ uploadId: 'up1', filePath: file, size: 16, meta })).rejects.toThrow(/500/)
    expect(fs.existsSync(file)).toBe(true)
  })
})
