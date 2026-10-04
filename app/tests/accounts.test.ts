import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import express from 'express'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { Server } from 'http'
import type { AddressInfo } from 'net'
import { closeDb, openDb } from '../src/attribution/db'
import { resetLoginThrottle } from '../src/account/session'
import { safeNext } from '../src/account/routes'

/*
  Accounts end to end against a fake Immich that keeps real state: invites,
  sign-up, auto-joining an album, access control on photos, bots, the JSON
  API's CSRF/admin checks, and member uploads.
*/

const realFetch = globalThis.fetch
const ALBUM = '11111111-2222-4333-8444-555555555555'
const ASSET = '99999999-2222-4333-8444-555555555555'
const b64 = (s: string) => Buffer.from(s).toString('base64')

interface User { id: string, name: string, email: string, password: string, isAdmin: boolean }
const users: User[] = [{ id: 'u-daniel', name: 'Daniel', email: 'daniel@example.com', password: 'host-pass-1', isAdmin: true }]
// Immich v3 shape: the owner is the albumUsers entry with role 'owner'
const album = { id: ALBUM, albumName: 'Beach', assetCount: 3, albumThumbnailAssetId: null as string | null, albumUsers: [{ user: { id: 'u-daniel', name: 'Daniel' }, role: 'owner' }] as Array<{ user: { id: string, name: string }, role: string }> }
const isMember = (id: string) => album.albumUsers.some(x => x.user.id === id)
const isOwner = (id: string) => album.albumUsers.some(x => x.user.id === id && x.role === 'owner')
const link = { id: 'l1', key: 'invitekey', slug: 'beach', type: 'ALBUM', allowUpload: true, allowDownload: true, assets: [], expiresAt: null, album }
const calls: Array<{ method: string, path: string, body?: unknown }> = []

const tokenUser = (h: Record<string, string>) => users.find(u => h.Authorization === 'Bearer tok-' + u.id)

describe('accounts', () => {
  let server: Server
  let base: string
  let tmp: string
  let danielCookie = ''
  let aminaCookie = ''

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ipp-acc-'))
    Object.assign(process.env, {
      IMMICH_URL: 'http://immich',
      IMMICH_API_KEY: 'host-key',
      UPLOAD_TMP_DIR: tmp,
      COOKIE_INSECURE: 'true',
      PUBLIC_BASE_URL: 'https://photos.example'
    })
    closeDb()
    openDb(':memory:')
    resetLoginThrottle()
    for (const m of ['log', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation(() => {})

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input)
      if (!url.startsWith('http://immich')) return realFetch(input, init)
      const u = new URL(url)
      const method = init.method || 'GET'
      const h = (init.headers || {}) as Record<string, string>
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
      calls.push({ method, path: u.pathname, body })
      const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } })
      const p = u.pathname.replace('/api', '')
      const hostKey = h['x-api-key'] === 'host-key'
      const me = tokenUser(h)

      if (p === '/shared-links/me') {
        const k = u.searchParams.get('key') || u.searchParams.get('slug')
        return k === link.key || k === link.slug ? json(link) : json({ message: 'Invalid share key' }, 401)
      }
      if (p === '/timeline/buckets') return json([])
      if (p === '/auth/login') {
        const user = users.find(x => x.email === body.email && x.password === body.password)
        return user ? json({ accessToken: 'tok-' + user.id, userId: user.id, name: user.name, userEmail: user.email, isAdmin: user.isAdmin }) : json({ message: 'bad' }, 401)
      }
      if (p === '/auth/logout') return json({})
      if (p === '/admin/users' && method === 'POST' && hostKey) {
        if (users.some(x => x.email === body.email)) return json({ message: 'User exists' }, 400)
        users.push({ id: 'u-' + body.name.toLowerCase(), name: body.name, email: body.email, password: body.password, isAdmin: false })
        return json({ id: 'u-' + body.name.toLowerCase() })
      }
      if (p === `/albums/${ALBUM}/users` && method === 'PUT' && hostKey) {
        for (const au of body.albumUsers) {
          const user = users.find(x => x.id === au.userId)!
          album.albumUsers.push({ user: { id: user.id, name: user.name }, role: au.role })
        }
        return json(album)
      }
      if (p === `/albums/${ALBUM}` && method === 'GET') {
        const ok = me && isMember(me.id)
        return ok ? json(album) : json({ message: 'Not found or no album.read access' }, 400)
      }
      if (p === '/albums' && method === 'GET' && me) {
        const owned = u.searchParams.get('isOwned') === 'true'
        const mine = isOwner(me.id)
        return json(owned ? (mine ? [album] : []) : (isMember(me.id) && !mine ? [album] : []))
      }
      if (p === '/albums' && method === 'POST' && me) return json({ id: '22222222-2222-4333-8444-555555555555' })
      if (p === '/shared-links' && method === 'POST' && me) return json({ id: 'l2', key: 'newkey', slug: null, allowUpload: true, allowDownload: true })
      if (p === '/shared-links' && method === 'GET') return json(me?.id === 'u-daniel' ? [link] : [])
      return json({ message: 'not mocked ' + method + ' ' + p }, 500)
    }))

    const { blockBots } = await import('../src/account/bots')
    const { loadAccount, albumGate } = await import('../src/account/access')
    const { accountRouter, gateViews } = await import('../src/account/routes')
    const { mountUploads } = await import('../src/upload/server')
    const app = express()
    app.use(blockBots)
    mountUploads(app)
    app.use(express.json())
    app.use(express.urlencoded({ extended: false }))
    app.use(loadAccount)
    app.use(accountRouter())
    app.use(albumGate(gateViews))
    // Stand-ins for IPP's album routes, reached only through the gate
    app.get('/:shareType(share|s)/:key', (_req, res) => { res.send('GALLERY role=' + res.locals.role) })
    app.get('/share/photo/:key/:id/:size?', (_req, res) => { res.send('PHOTO') })
    app.get('/robots.txt', (_req, res) => { res.send('User-agent: *\nDisallow: /') })
    await new Promise<void>(resolve => { server = app.listen(0, resolve) })
    base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
  })

  afterAll(() => {
    server?.close()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  const get = (p: string, cookie = '', ua = 'Mozilla/5.0 Safari') =>
    realFetch(base + p, { headers: { cookie, 'user-agent': ua, accept: 'text/html' }, redirect: 'manual' })
  const form = (p: string, data: Record<string, string>, cookie = '') => realFetch(base + p, {
    method: 'POST',
    headers: { cookie, 'Content-Type': 'application/x-www-form-urlencoded', 'user-agent': 'Mozilla/5.0' },
    body: new URLSearchParams(data).toString(),
    redirect: 'manual'
  })
  const cookieOf = (res: Response) => (res.headers.get('set-cookie') || '').split(';')[0]

  it('turns crawlers away and marks everything noindex', async () => {
    expect((await get('/s/beach', '', 'Mozilla/5.0 (compatible; GPTBot/1.2)')).status).toBe(403)
    expect((await get('/login', '', 'Googlebot/2.1')).status).toBe(403)
    expect((await get('/robots.txt', '', 'Googlebot/2.1')).status).toBe(200)
    const page = await get('/login')
    expect(page.headers.get('x-robots-tag')).toMatch(/noindex/)
  })

  it('lets link-preview bots see the invite title but never a photo', async () => {
    const res = await get('/s/beach', '', 'WhatsApp/2.23')
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('Daniel invited you to Beach')
    expect(html).not.toMatch(/og:image|\/share\/photo\//)
  })

  it('shows the invite to signed-out visitors and hides photos', async () => {
    const html = await (await get('/s/beach')).text()
    expect(html).toContain('Beach')
    expect(html).toContain('Join the album')
    expect((await get(`/share/photo/invitekey/${ASSET}/thumbnail`)).status).toBe(404)
    expect((await get('/')).headers.get('location')).toBe('/login')
    expect((await get('/s/nope')).status).toBe(404)
  })

  it('only creates accounts from a valid invite', async () => {
    const res = await form('/signup', { name: 'Eve', email: 'eve@example.com', password: 'longenough', invite: 'forged', inviteType: 'key', next: '/' })
    expect(res.status).toBe(403)
    expect(users.some(u => u.email === 'eve@example.com')).toBe(false)
  })

  it('validates sign-up fields', async () => {
    const short = await form('/signup', { name: 'Amina', email: 'amina@example.com', password: 'short', invite: 'beach', inviteType: 'slug', next: '/s/beach' })
    expect(short.status).toBe(400)
    expect(await short.text()).toContain('at least 8 characters')
  })

  it('signs a friend up from the invite and adds them to the album', async () => {
    const res = await form('/signup', { name: 'Amina', email: 'Amina@Example.com', password: 'sunny-days-42', invite: 'beach', inviteType: 'slug', next: '/s/beach' })
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/s/beach')
    aminaCookie = cookieOf(res)
    expect(res.headers.get('set-cookie')).toMatch(/HttpOnly/)
    expect(users.find(u => u.name === 'Amina')?.email).toBe('amina@example.com')

    // Before opening the invite, photos stay closed to her
    expect((await get(`/share/photo/invitekey/${ASSET}/thumbnail`, aminaCookie)).status).toBe(404)
    // Opening the invite joins the album as an editor (the link allows uploads)
    expect(await (await get('/s/beach', aminaCookie)).text()).toBe('GALLERY role=editor')
    expect(calls).toContainEqual(expect.objectContaining({ method: 'PUT', path: `/api/albums/${ALBUM}/users`, body: { albumUsers: [{ userId: 'u-amina', role: 'editor' }] } }))
    expect(await (await get(`/share/photo/invitekey/${ASSET}/thumbnail`, aminaCookie)).text()).toBe('PHOTO')
  })

  it('refuses a duplicate account and suggests signing in', async () => {
    const res = await form('/signup', { name: 'Amina', email: 'amina@example.com', password: 'another-pass', invite: 'beach', inviteType: 'slug', next: '/s/beach' })
    expect(res.status).toBe(409)
    expect(await res.text()).toContain('Sign in instead')
  })

  it('lists the album under "Shared with you" on her home page', async () => {
    const html = await (await get('/', aminaCookie)).text()
    expect(html).toContain('Shared with you')
    expect(html).toContain('href="/s/beach"')
    expect(html).not.toContain('id="new-album"')
  })

  it('throttles wrong passwords', async () => {
    for (let i = 0; i < 5; i++) expect((await form('/login', { email: 'daniel@example.com', password: 'nope', next: '/' })).status).toBe(401)
    expect((await form('/login', { email: 'daniel@example.com', password: 'host-pass-1', next: '/' })).status).toBe(429)
    resetLoginThrottle()
  })

  it('signs the host in and only redirects to same-site paths', async () => {
    const res = await form('/login', { email: 'daniel@example.com', password: 'host-pass-1', next: '//evil.example/x' })
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/')
    danielCookie = cookieOf(res)
    expect(safeNext('/s/beach')).toBe('/s/beach')
    expect(safeNext('https://evil.example')).toBe('/')
    expect(safeNext('/\\evil.example')).toBe('/')
  })

  it('guards the JSON API: CSRF header, sign-in, and host-only album creation', async () => {
    const post = (cookie: string, headers: Record<string, string> = { 'X-Requested-With': 'photos-share' }) =>
      realFetch(base + '/api/albums', { method: 'POST', headers: { cookie, 'Content-Type': 'application/json', ...headers }, body: '{"name":"Party"}' })
    expect((await post('')).status).toBe(401)
    expect((await post(danielCookie, {})).status).toBe(403)
    expect((await post(aminaCookie)).status).toBe(403)
    const ok = await post(danielCookie)
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ url: '/share/newkey' })
  })

  it('lets members who can edit upload, and nobody else', async () => {
    const create = (cookie: string) => realFetch(base + '/share/upload', {
      method: 'POST',
      headers: {
        cookie,
        'Tus-Resumable': '1.0.0',
        'Upload-Length': '5',
        'Upload-Metadata': `mode ${b64('member')},albumId ${b64(ALBUM)},filename ${b64('a.jpg')},filetype ${b64('image/jpeg')}`
      }
    })
    expect((await create('')).status).toBe(401)
    const ok = await create(aminaCookie)
    expect(ok.status).toBe(201)
    const id = (ok.headers.get('location') || '').split('/').pop() as string
    const stored = JSON.parse(fs.readFileSync(path.join(tmp, id + '.json'), 'utf8'))
    expect(stored.metadata).toMatchObject({ mode: 'member', albumId: ALBUM, uploader: 'Amina', albumName: 'Beach' })
    expect(JSON.stringify(stored.metadata)).not.toContain('tok-')

    // A viewer can't add
    album.albumUsers.find(x => x.user.id === 'u-amina')!.role = 'viewer'
    const { forgetAlbumAccess } = await import('../src/account/access')
    forgetAlbumAccess('u-amina', ALBUM)
    expect((await create(aminaCookie)).status).toBe(403)
  })

  it('signs out and ends the session', async () => {
    await form('/logout', {}, aminaCookie)
    expect((await get('/', aminaCookie)).headers.get('location')).toBe('/login')
    expect((await get(`/share/photo/invitekey/${ASSET}/thumbnail`, aminaCookie)).status).toBe(404)
  })
})
