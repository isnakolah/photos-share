import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import express from 'express'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { Server } from 'http'
import type { AddressInfo } from 'net'
import { closeDb, openDb } from '../src/attribution/db'

/*
  End-to-end through the tus protocol with a fake Immich: create -> PATCH ->
  background hand-off -> status poll. Also checks the share gate refuses links
  without "allow upload", unknown links, and uploads without a name.
*/

const realFetch = globalThis.fetch
const b64 = (s: string) => Buffer.from(s).toString('base64')
const metaHeader = (m: Record<string, string>) => Object.entries(m).map(([k, v]) => k + ' ' + b64(v)).join(',')

const shares: Record<string, object> = {
  open: { id: 'l1', key: 'open', type: 'ALBUM', allowUpload: true, allowDownload: true, assets: [], expiresAt: null, album: { id: 'album-1', albumName: 'Beach' } },
  viewonly: { id: 'l2', key: 'viewonly', type: 'ALBUM', allowUpload: false, assets: [], expiresAt: null, album: { id: 'album-2' } }
}
const immichCalls: string[] = []

describe('tus upload endpoint', () => {
  let server: Server
  let base: string
  let tmp: string

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ipp-up-'))
    process.env.IMMICH_URL = 'http://immich'
    process.env.IMMICH_API_KEY = 'secret'
    process.env.UPLOAD_TMP_DIR = tmp
    closeDb()
    openDb(':memory:')
    vi.spyOn(console, 'log').mockImplementation(() => {})

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input)
      if (!url.startsWith('http://immich')) return realFetch(input, init)
      const u = new URL(url)
      const method = init.method || 'GET'
      immichCalls.push(method + ' ' + u.pathname)
      const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } })
      if (u.pathname === '/api/shared-links/me') {
        const share = shares[u.searchParams.get('key') || '']
        return share ? json(share) : json({ message: 'Invalid share key' }, 401)
      }
      if (u.pathname === '/api/timeline/buckets') return json([])
      if (method === 'POST' && u.pathname === '/api/assets') return json({ id: 'asset-9', status: 'created' })
      if (u.pathname === '/api/assets/asset-9' && method === 'GET') return json({ id: 'asset-9', exifInfo: {} })
      if (u.pathname === '/api/tags') return json([{ id: 't1', value: 'uploader/Amina' }])
      return json({})
    }))

    const { mountUploads } = await import('../src/upload/server')
    const app = express()
    mountUploads(app)
    await new Promise<void>(resolve => { server = app.listen(0, resolve) })
    base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
  })

  afterAll(() => {
    server?.close()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  const create = (meta: Record<string, string>, length = 11) => realFetch(base + '/share/upload', {
    method: 'POST',
    headers: { 'Tus-Resumable': '1.0.0', 'Upload-Length': String(length), 'Upload-Metadata': metaHeader(meta) }
  })

  const good = { shareKey: 'open', uploader: 'Amina', filename: 'IMG_1.jpg', filetype: 'image/jpeg', lastModified: '1754042400000' }

  it('refuses links without allow-upload, unknown links, nameless uploads and non-media', async () => {
    expect((await create({ ...good, shareKey: 'viewonly' })).status).toBe(403)
    expect((await create({ ...good, shareKey: 'nope' })).status).toBe(404)
    expect((await create({ ...good, uploader: '  ' })).status).toBe(400)
    expect((await create({ ...good, filename: 'x.exe', filetype: 'application/x-msdownload' })).status).toBe(415)
  })

  it('accepts a chunked upload and hands it to Immich with attribution', async () => {
    const res = await create(good)
    expect(res.status).toBe(201)
    const location = res.headers.get('location') || ''
    expect(location).toMatch(/^\/share\/upload\/[0-9a-f]+$/)
    const id = location.split('/').pop() as string

    // Server-side metadata must not be client-controllable
    const stored = JSON.parse(fs.readFileSync(path.join(tmp, id + '.json'), 'utf8'))
    expect(stored.metadata).toMatchObject({ albumId: 'album-1', uploader: 'Amina', shareSlug: '' })

    const patch = (offset: number, body: string) => realFetch(base + location, {
      method: 'PATCH',
      headers: { 'Tus-Resumable': '1.0.0', 'Upload-Offset': String(offset), 'Content-Type': 'application/offset+octet-stream' },
      body
    })
    expect((await patch(0, 'hello ')).status).toBe(204)
    expect((await patch(6, 'world')).status).toBe(204)

    let status = ''
    for (let i = 0; i < 50 && status !== 'done'; i++) {
      await new Promise(resolve => setTimeout(resolve, 20))
      const s = await (await realFetch(base + '/share/upload/status?ids=' + id)).json()
      status = s[0].status
    }
    expect(status).toBe('done')
    expect(immichCalls).toContain('POST /api/assets')
    expect(immichCalls).toContain('PUT /api/albums/album-1/assets')
    expect(immichCalls).toContain('PUT /api/tags/assets')
  })
})
