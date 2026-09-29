import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { closeDb, getByUploadIds, openDb, recordPending } from '../src/attribution/db'
import { processJob, UploadMeta } from '../src/upload/processor'

const meta: UploadMeta = {
  shareKey: 'key1', shareSlug: 'beach', albumId: 'album-1', albumName: 'Beach',
  uploader: 'Amina', filename: 'IMG_1.HEIC', filetype: 'image/heic',
  lastModified: String(Date.parse('2026-08-01T10:00:00Z')), ip: '1.2.3.4', userAgent: 'test'
}

interface Call { method: string, url: string, body?: unknown, headers: Record<string, string> }

function mockImmich (opts: { status?: 'created' | 'duplicate', description?: string } = {}) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method || 'GET'
    const headers = init.headers as Record<string, string>
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body
    calls.push({ method, url: url.replace('http://immich/api', ''), body, headers })
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'Content-Type': 'application/json' } })
    if (method === 'POST' && url.endsWith('/assets')) return json({ id: 'asset-1', status: opts.status || 'created' })
    if (method === 'PUT' && url.includes('/albums/')) return json([{ id: 'asset-1', success: true }])
    if (method === 'GET' && url.endsWith('/assets/asset-1')) return json({ id: 'asset-1', exifInfo: { description: opts.description || '' } })
    if (method === 'PUT' && url.endsWith('/assets/asset-1')) return json({})
    if (method === 'PUT' && url.endsWith('/tags')) return json([{ id: 'tag-1', value: 'uploader/Amina' }])
    if (method === 'PUT' && url.endsWith('/tags/assets')) return json({ count: 1 })
    return new Response('not mocked', { status: 500 })
  }))
  return calls
}

describe('processJob', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    process.env.IMMICH_URL = 'http://immich'
    process.env.IMMICH_API_KEY = 'secret'
    closeDb()
    openDb(':memory:')
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tus-'))
    file = path.join(dir, 'up1')
    fs.writeFileSync(file, 'fake image bytes')
    fs.writeFileSync(file + '.json', '{}')
    recordPending({ uploadId: 'up1', uploader: 'Amina', shareKey: 'key1', albumId: 'album-1', albumName: 'Beach', filename: 'IMG_1.HEIC', size: 16, mimeType: 'image/heic', ip: '', userAgent: '' })
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('uploads with the API key, adds to the album, attributes, and cleans up', async () => {
    const calls = mockImmich()
    await processJob({ uploadId: 'up1', filePath: file, size: 16, meta })

    const upload = calls.find(c => c.method === 'POST')!
    expect(upload.url).toBe('/assets')
    expect(upload.headers['x-api-key']).toBe('secret')
    const form = upload.body as FormData
    expect(form.get('fileCreatedAt')).toBe('2026-08-01T10:00:00.000Z')
    expect(form.get('filename')).toBe('IMG_1.HEIC')
    expect((form.get('assetData') as File).name).toBe('IMG_1.HEIC')

    expect(calls).toContainEqual(expect.objectContaining({ method: 'PUT', url: '/albums/album-1/assets', body: { ids: ['asset-1'] } }))
    expect(calls).toContainEqual(expect.objectContaining({ method: 'PUT', url: '/assets/asset-1', body: { description: 'Added by Amina' } }))
    expect(calls).toContainEqual(expect.objectContaining({ method: 'PUT', url: '/tags', body: { tags: ['uploader/Amina'] } }))
    expect(calls).toContainEqual(expect.objectContaining({ method: 'PUT', url: '/tags/assets', body: { tagIds: ['tag-1'], assetIds: ['asset-1'] } }))

    expect(getByUploadIds(['up1'])[0]).toMatchObject({ status: 'done', assetId: 'asset-1', duplicate: false })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(fs.existsSync(file)).toBe(false)
    expect(fs.existsSync(file + '.json')).toBe(false)
  })

  it('does not overwrite the description of an existing duplicate', async () => {
    const calls = mockImmich({ status: 'duplicate', description: 'Sunset at Diani' })
    await processJob({ uploadId: 'up1', filePath: file, size: 16, meta })
    expect(calls.some(c => c.method === 'PUT' && c.url === '/assets/asset-1')).toBe(false)
    expect(getByUploadIds(['up1'])[0]).toMatchObject({ status: 'done', duplicate: true })
  })

  it('appends to an existing description on a new asset', async () => {
    const calls = mockImmich({ description: 'Sunset' })
    await processJob({ uploadId: 'up1', filePath: file, size: 16, meta })
    expect(calls).toContainEqual(expect.objectContaining({ url: '/assets/asset-1', body: { description: 'Sunset\n\nAdded by Amina' } }))
  })

  it('throws (so the queue retries) when Immich rejects the upload', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })))
    await expect(processJob({ uploadId: 'up1', filePath: file, size: 16, meta })).rejects.toThrow(/500/)
    expect(fs.existsSync(file)).toBe(true)
  })
})
