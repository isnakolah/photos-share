import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import express from 'express'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { Server } from 'http'
import type { AddressInfo } from 'net'
import { closeDb, openDb } from '../src/attribution/db'
import { resetLoginThrottle } from '../src/owner/session'

/*
  Owner area end to end with a fake Immich: sign-in, throttling, CSRF header
  check, album listing, and an owner tus upload that must go to Immich with
  the owner's own token and without guest attribution.
*/

const realFetch = globalThis.fetch
const b64 = (s: string) => Buffer.from(s).toString('base64')
const ALBUM = '11111111-2222-4333-8444-555555555555'
const calls: Array<{ method: string, path: string, auth: string }> = []

describe('owner area', () => {
  let server: Server
  let base: string
  let tmp: string
  let cookie = ''

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ipp-owner-'))
    process.env.IMMICH_URL = 'http://immich'
    process.env.IMMICH_API_KEY = 'server-key'
    process.env.UPLOAD_TMP_DIR = tmp
    process.env.OWNER_COOKIE_INSECURE = 'true'
    process.env.PUBLIC_BASE_URL = 'https://photos.example'
    closeDb()
    openDb(':memory:')
    resetLoginThrottle()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input)
      if (!url.startsWith('http://immich')) return realFetch(input, init)
      const u = new URL(url)
      const method = init.method || 'GET'
      const h = (init.headers || {}) as Record<string, string>
      calls.push({ method, path: u.pathname, auth: h.Authorization || (h['x-api-key'] ? 'key:' + h['x-api-key'] : '') })
      const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } })
      if (u.pathname === '/api/auth/login') {
        const body = JSON.parse(String(init.body))
        return body.password === 'right'
          ? json({ accessToken: 'owner-token', userId: 'u1', name: 'Daniel', userEmail: body.email })
          : json({ message: 'Incorrect email or password' }, 401)
      }
      if (h.Authorization !== 'Bearer owner-token' && !h['x-api-key']) return json({ message: 'unauth' }, 401)
      if (u.pathname === '/api/albums' && method === 'GET') return json([{ id: ALBUM, albumName: 'Kericho', assetCount: 3, albumThumbnailAssetId: null }])
      if (u.pathname === '/api/shared-links') return json([])
      if (u.pathname === '/api/albums/' + ALBUM && method === 'GET') return json({ id: ALBUM, albumName: 'Kericho' })
      if (u.pathname === '/api/assets' && method === 'POST') return json({ id: 'asset-7', status: 'created' })
      return json({})
    }))

    const { mountUploads } = await import('../src/upload/server')
    const { ownerRouter } = await import('../src/owner/routes')
    const app = express()
    mountUploads(app)
    app.use(express.json())
    app.use(express.urlencoded({ extended: false }))
    app.use(ownerRouter())
    app.get('/elsewhere', (_req, res) => { res.send('ok') })
    await new Promise<void>(resolve => { server = app.listen(0, resolve) })
    base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
  })

  afterAll(() => {
    server?.close()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  const login = (password: string) => realFetch(base + '/owner/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'email=me%40example.com&password=' + password,
    redirect: 'manual'
  })

  it('does not leak owner headers onto other routes', async () => {
    const res = await realFetch(base + '/elsewhere')
    expect(res.headers.get('cache-control')).toBeNull()
  })

  it('shows the sign-in page when signed out, and rejects API calls', async () => {
    expect(await (await realFetch(base + '/owner')).text()).toContain('Sign in')
    expect((await realFetch(base + '/owner/api/albums')).status).toBe(401)
  })

  it('rejects a wrong password, then throttles', async () => {
    for (let i = 0; i < 5; i++) expect((await login('wrong')).status).toBe(401)
    expect((await login('right')).status).toBe(429)
    resetLoginThrottle()
  })

  it('signs in with Immich credentials and sets a secure-style session cookie', async () => {
    const res = await login('right')
    expect(res.status).toBe(303)
    const set = res.headers.get('set-cookie') || ''
    expect(set).toMatch(/owner_sid=/)
    expect(set).toMatch(/HttpOnly/)
    expect(set).toMatch(/SameSite=Strict/)
    cookie = set.split(';')[0]
    expect(await (await realFetch(base + '/owner', { headers: { cookie } })).text()).toContain('Your albums')
  })

  it('lists albums with the owner token and requires the CSRF header for writes', async () => {
    const albums = await (await realFetch(base + '/owner/api/albums', { headers: { cookie } })).json()
    expect(albums).toEqual([expect.objectContaining({ id: ALBUM, name: 'Kericho', count: 3, link: null })])
    expect(calls.find(c => c.path === '/api/albums')?.auth).toBe('Bearer owner-token')

    const noHeader = await realFetch(base + '/owner/api/albums', {
      method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: '{"name":"x"}'
    })
    expect(noHeader.status).toBe(403)
  })

  it('refuses owner uploads without a session', async () => {
    const res = await realFetch(base + '/share/upload', {
      method: 'POST',
      headers: {
        'Tus-Resumable': '1.0.0',
        'Upload-Length': '5',
        'Upload-Metadata': `mode ${b64('owner')},albumId ${b64(ALBUM)},filename ${b64('a.jpg')},filetype ${b64('image/jpeg')}`
      }
    })
    expect(res.status).toBe(401)
  })

  it('uploads into the album as the owner, without guest attribution', async () => {
    calls.length = 0
    const create = await realFetch(base + '/share/upload', {
      method: 'POST',
      headers: {
        cookie,
        'Tus-Resumable': '1.0.0',
        'Upload-Length': '5',
        'Upload-Metadata': `mode ${b64('owner')},albumId ${b64(ALBUM)},filename ${b64('a.jpg')},filetype ${b64('image/jpeg')}`
      }
    })
    expect(create.status).toBe(201)
    const location = create.headers.get('location') as string
    const id = location.split('/').pop() as string
    const stored = JSON.parse(fs.readFileSync(path.join(tmp, id + '.json'), 'utf8'))
    expect(stored.metadata).toMatchObject({ mode: 'owner', albumId: ALBUM, uploader: 'Daniel', albumName: 'Kericho' })
    expect(JSON.stringify(stored.metadata)).not.toContain('owner-token')

    const patch = await realFetch(base + location, {
      method: 'PATCH',
      headers: { 'Tus-Resumable': '1.0.0', 'Upload-Offset': '0', 'Content-Type': 'application/offset+octet-stream' },
      body: 'hello'
    })
    expect(patch.status).toBe(204)

    let status = ''
    for (let i = 0; i < 50 && status !== 'done'; i++) {
      await new Promise(resolve => setTimeout(resolve, 20))
      status = (await (await realFetch(base + '/share/upload/status?ids=' + id)).json())[0].status
    }
    expect(status).toBe('done')
    const upload = calls.find(c => c.method === 'POST' && c.path === '/api/assets')
    expect(upload?.auth).toBe('Bearer owner-token')
    expect(calls.find(c => c.path === `/api/albums/${ALBUM}/assets`)?.auth).toBe('Bearer owner-token')
    expect(calls.some(c => c.path.startsWith('/api/tags'))).toBe(false)
  })

  it('signs out and invalidates the session', async () => {
    await realFetch(base + '/owner/logout', { method: 'POST', headers: { cookie }, redirect: 'manual' })
    expect((await realFetch(base + '/owner/api/albums', { headers: { cookie } })).status).toBe(401)
  })
})
