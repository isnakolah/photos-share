import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import express from 'express'
import type { Server } from 'http'
import type { AddressInfo } from 'net'
import { closeDb, openDb } from '../src/attribution/db'
import { createSession } from '../src/account/session'

/*
  Album management against a stateful fake Immich: who may delete which
  photos, the album owner's People controls, rename and delete album.
*/

const realFetch = globalThis.fetch
const ALBUM = '11111111-2222-4333-8444-555555555555'
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const DANIEL = id(901)
const AMINA = id(902)
const OTIENO = id(903)

// Two photos each from Daniel (admin, owner), Amina (editor); Otieno has an account but isn't in the album
let assets: Array<{ id: string, owner: string }>
let album: { id: string, albumName: string, assetCount: number, albumThumbnailAssetId: null, albumUsers: Array<{ user: { id: string, name: string }, role: string }> }
let albumDeleted = false
const trashed: string[] = []
const people = [{ id: DANIEL, name: 'Daniel', email: 'd@example.com' }, { id: AMINA, name: 'Amina', email: 'a@example.com' }, { id: OTIENO, name: 'Otieno', email: 'o@example.com' }]
const userOf = (h: Record<string, string>) => people.find(p => h.Authorization === 'Bearer tok-' + p.id)

function reset () {
  assets = [{ id: id(1), owner: DANIEL }, { id: id(2), owner: DANIEL }, { id: id(3), owner: AMINA }, { id: id(4), owner: AMINA }]
  album = { id: ALBUM, albumName: 'Beach', assetCount: 4, albumThumbnailAssetId: null, albumUsers: [{ user: { id: DANIEL, name: 'Daniel' }, role: 'owner' }, { user: { id: AMINA, name: 'Amina' }, role: 'editor' }] }
  albumDeleted = false
  trashed.length = 0
}

describe('album management', () => {
  let server: Server
  let base: string
  const cookies: Record<string, string> = {}

  beforeAll(async () => {
    reset()
    Object.assign(process.env, { IMMICH_URL: 'http://immich', IMMICH_API_KEY: 'host-key', COOKIE_INSECURE: 'true' })
    closeDb()
    openDb(':memory:')
    for (const m of ['log', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation(() => {})
    cookies.daniel = 'photos_sid=' + createSession({ token: 'tok-' + DANIEL, userId: DANIEL, name: 'Daniel', email: 'd@example.com', isAdmin: true }).sid
    cookies.amina = 'photos_sid=' + createSession({ token: 'tok-' + AMINA, userId: AMINA, name: 'Amina', email: 'a@example.com', isAdmin: false }).sid
    cookies.otieno = 'photos_sid=' + createSession({ token: 'tok-' + OTIENO, userId: OTIENO, name: 'Otieno', email: 'o@example.com', isAdmin: false }).sid

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input)
      if (!url.startsWith('http://immich')) return realFetch(input, init)
      const u = new URL(url)
      const p = u.pathname.replace('/api', '')
      const method = init.method || 'GET'
      const h = (init.headers || {}) as Record<string, string>
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
      const me = userOf(h)
      const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } })
      const member = me && !albumDeleted && album.albumUsers.some(x => x.user.id === me.id)
      const isOwner = me && album.albumUsers.some(x => x.user.id === me.id && x.role === 'owner')

      if (p === `/albums/${ALBUM}` && method === 'GET') return member ? json(album) : json({ message: 'no access' }, 400)
      if (p === '/timeline/buckets' && member) return json([{ timeBucket: '2026-01-01', count: assets.length }])
      if (p === '/timeline/bucket' && member) return json({ id: assets.map(a => a.id), ownerId: assets.map(a => a.owner) })
      if (p === '/assets' && method === 'DELETE') {
        // Immich: only the owner can trash an asset
        if (!body.ids.every((x: string) => assets.find(a => a.id === x)?.owner === me?.id)) return json({ message: 'Not found or no asset.delete access' }, 400)
        trashed.push(...body.ids)
        assets = assets.filter(a => !body.ids.includes(a.id))
        return json({})
      }
      if (p === `/albums/${ALBUM}/assets` && method === 'DELETE') {
        if (!isOwner) return json({ message: 'no access' }, 400)
        assets = assets.filter(a => !body.ids.includes(a.id))
        return json(body.ids.map((x: string) => ({ id: x, success: true })))
      }
      if (p === '/users' && me) return json(people)
      if (p === `/albums/${ALBUM}/users` && method === 'PUT' && isOwner) {
        for (const au of body.albumUsers) album.albumUsers.push({ user: { id: au.userId, name: people.find(x => x.id === au.userId)!.name }, role: au.role })
        return json(album)
      }
      const m = p.match(new RegExp(`^/albums/${ALBUM}/user/(.+)$`))
      if (m && isOwner && method === 'PUT') {
        album.albumUsers.find(x => x.user.id === m[1])!.role = body.role
        return json({})
      }
      if (m && isOwner && method === 'DELETE') {
        album.albumUsers = album.albumUsers.filter(x => x.user.id !== m[1])
        return json({})
      }
      if (p === `/albums/${ALBUM}` && method === 'PATCH' && isOwner) {
        album.albumName = body.albumName
        return json(album)
      }
      if (p === `/albums/${ALBUM}` && method === 'DELETE' && isOwner) {
        albumDeleted = true
        return json({})
      }
      return json({ message: 'not mocked ' + method + ' ' + p }, 500)
    }))

    const { loadAccount } = await import('../src/account/access')
    const { accountRouter } = await import('../src/account/routes')
    const app = express()
    app.use(express.json())
    app.use(loadAccount)
    app.use(accountRouter())
    await new Promise<void>(resolve => { server = app.listen(0, resolve) })
    base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
  })

  afterAll(() => {
    server?.close()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const call = async (who: string, method: string, path: string, body?: unknown) => {
    const res = await realFetch(base + '/api' + path, {
      method,
      headers: { cookie: cookies[who], 'X-Requested-With': 'photos-share', 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined
    })
    return { status: res.status, body: await res.json().catch(() => ({})) }
  }
  const forget = async () => {
    const { forgetAlbumAccess } = await import('../src/account/access')
    for (const p of people) forgetAlbumAccess(p.id, ALBUM)
  }

  it('lets a friend delete only what they added (to the trash)', async () => {
    const r = await call('amina', 'POST', `/albums/${ALBUM}/assets/delete`, { ids: [id(3), id(1)] })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ trashed: [id(3)], removed: [], refused: [id(1)] })
    expect(trashed).toEqual([id(3)])
    expect(assets.map(a => a.id)).toEqual([id(1), id(2), id(4)])
  })

  it('lets the admin delete anything: own photos to trash, others out of the album', async () => {
    const r = await call('daniel', 'POST', `/albums/${ALBUM}/assets/delete`, { ids: [id(2), id(4)] })
    expect(r.body).toEqual({ trashed: [id(2)], removed: [id(4)], refused: [] })
    expect(trashed).toContain(id(2))
    expect(trashed).not.toContain(id(4)) // friend's file stays in their account
    expect(assets.map(a => a.id)).toEqual([id(1)])
  })

  it('refuses photos outside the album and non-members', async () => {
    const r = await call('daniel', 'POST', `/albums/${ALBUM}/assets/delete`, { ids: [id(77)] })
    expect(r.body.refused).toEqual([id(77)])
    expect((await call('otieno', 'POST', `/albums/${ALBUM}/assets/delete`, { ids: [id(1)] })).status).toBe(404)
    expect((await call('daniel', 'POST', `/albums/${ALBUM}/assets/delete`, { ids: ['../etc'] })).status).toBe(400)
  })

  it('shows the owner who is in the album and who could be added', async () => {
    expect((await call('amina', 'GET', `/albums/${ALBUM}/people`)).status).toBe(403)
    const r = await call('daniel', 'GET', `/albums/${ALBUM}/people`)
    expect(r.body.members.map((m: { name: string, role: string }) => m.name + ':' + m.role)).toEqual(['Daniel:owner', 'Amina:editor'])
    expect(r.body.others).toEqual([{ id: OTIENO, name: 'Otieno', email: 'o@example.com' }])
  })

  it('adds an existing account without a link, changes roles, and removes people', async () => {
    expect((await call('daniel', 'POST', `/albums/${ALBUM}/people`, { userId: OTIENO, role: 'viewer' })).status).toBe(200)
    await forget()
    expect((await call('otieno', 'POST', `/albums/${ALBUM}/assets/delete`, { ids: [id(1)] })).body.refused).toEqual([id(1)])

    expect((await call('daniel', 'PATCH', `/albums/${ALBUM}/people/${AMINA}`, { role: 'viewer' })).status).toBe(200)
    expect(album.albumUsers.find(x => x.user.id === AMINA)?.role).toBe('viewer')
    expect((await call('daniel', 'PATCH', `/albums/${ALBUM}/people/${AMINA}`, { role: 'owner' })).status).toBe(400)

    expect((await call('daniel', 'DELETE', `/albums/${ALBUM}/people/${AMINA}`)).status).toBe(200)
    // She loses access straight away
    expect((await call('amina', 'GET', `/albums/${ALBUM}/people`)).status).toBe(403)
    expect((await call('amina', 'POST', `/albums/${ALBUM}/assets/delete`, { ids: [id(1)] })).status).toBe(404)
    expect((await call('daniel', 'DELETE', `/albums/${ALBUM}/people/${DANIEL}`)).status).toBe(400)
  })

  it('renames and deletes the album (owner only), optionally trashing own photos', async () => {
    expect((await call('otieno', 'PATCH', `/albums/${ALBUM}`, { name: 'Mine now' })).status).toBe(403)
    expect((await call('daniel', 'PATCH', `/albums/${ALBUM}`, { name: 'Beach 2026' })).body).toEqual({ name: 'Beach 2026' })
    expect(album.albumName).toBe('Beach 2026')

    expect((await call('otieno', 'POST', `/albums/${ALBUM}/delete`, {})).status).toBe(403)
    const r = await call('daniel', 'POST', `/albums/${ALBUM}/delete`, { trashMine: true })
    expect(r.body).toEqual({ url: '/', trashed: 1 })
    expect(albumDeleted).toBe(true)
    expect(trashed).toContain(id(1))
  })
})
