import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import express from 'express'
import type { Server } from 'http'
import type { AddressInfo } from 'net'
import { closeDb, momentoDraftFor, openDb } from '../src/attribution/db'
import { createSession } from '../src/account/session'

/*
  Momento projects: admin-only, forwards the service key and owner email to
  Momento's internal endpoints (list, open, new), remembers the last project,
  and turns Momento failures into a friendly error.
*/

const realFetch = globalThis.fetch
const ALBUM = '11111111-2222-4333-8444-555555555555'
const ADMIN = '00000000-0000-4000-8000-000000000901'
const FRIEND = '00000000-0000-4000-8000-000000000902'
const momentoCalls: Array<{ headers: Record<string, string>, body: Record<string, unknown> }> = []
let momentoStatus = 200

describe('Open in Momento', () => {
  let server: Server
  let base: string
  const cookies: Record<string, string> = {}

  beforeAll(async () => {
    Object.assign(process.env, {
      IMMICH_URL: 'http://immich',
      IMMICH_API_KEY: 'host-key',
      COOKIE_INSECURE: 'true',
      MOMENTO_INTERNAL_URL: 'http://momento-api:5110',
      MOMENTO_SERVICE_KEY: 'service-secret'
    })
    closeDb()
    openDb(':memory:')
    for (const m of ['log', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation(() => {})
    cookies.admin = 'photos_sid=' + createSession({ token: 'tok-admin', userId: ADMIN, name: 'Daniel', email: 'daniel@example.com', isAdmin: true }).sid
    cookies.friend = 'photos_sid=' + createSession({ token: 'tok-friend', userId: FRIEND, name: 'Amina', email: 'amina@example.com', isAdmin: false }).sid

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input)
      const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } })
      if (url.startsWith('http://momento-api:5110')) {
        momentoCalls.push({ headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) })
        if (momentoStatus !== 200) return json({ error: 'nope' }, momentoStatus)
        if (url.endsWith('/api/integrations/immich/projects')) {
          return json([{ draftId: 'Xy7', title: 'Photo book', updatedAt: '2026-10-05T10:00:00Z', photoCount: 12, coverUrl: 'https://momento.example.com/blob/c.webp', workspaceUrl: 'https://momento.example.com/app/drafts/Xy7' }])
        }
        return json({ draftId: 'Xy7', workspaceUrl: 'https://momento.example.com/app/drafts/Xy7', existed: false, imported: 12, skippedVideos: 1 })
      }
      if (url.startsWith('http://immich')) {
        const h = (init.headers || {}) as Record<string, string>
        if (url.includes(`/albums/${ALBUM}`)) {
          const owner = { user: { id: ADMIN, name: 'Daniel' }, role: 'owner' }
          return h.Authorization === 'Bearer tok-admin' ? json({ id: ALBUM, albumName: 'Kericho', assetCount: 12, albumUsers: [owner] }) : json({}, 400)
        }
        return json({}, 404)
      }
      return realFetch(input, init)
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

  const open = (cookie: string, body: object = {}, csrf = true) => realFetch(`${base}/api/albums/${ALBUM}/momento`, {
    method: 'POST',
    headers: { cookie, 'Content-Type': 'application/json', ...(csrf ? { 'X-Requested-With': 'photos-share' } : {}) },
    body: JSON.stringify(body)
  })

  it('is for the admin only, and needs the request header', async () => {
    expect((await open(cookies.friend)).status).toBe(403)
    expect((await open(cookies.admin, {}, false)).status).toBe(403)
    expect((await open('')).status).toBe(401)
    expect(momentoCalls).toHaveLength(0)
  })

  it('asks Momento for the album design and returns where to open it', async () => {
    const res = await open(cookies.admin)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ url: 'https://momento.example.com/app/drafts/Xy7', existed: false, imported: 12 })

    const call = momentoCalls.at(-1)!
    expect(call.headers['X-Momento-Service-Key']).toBe('service-secret')
    expect(call.body).toMatchObject({ immichAlbumId: ALBUM, ownerEmail: 'daniel@example.com', title: 'Kericho', fresh: false })
    expect(momentoDraftFor(ALBUM)).toEqual({ draftId: 'Xy7', workspaceUrl: 'https://momento.example.com/app/drafts/Xy7' })
  })

  it('passes "start a fresh design" through', async () => {
    await open(cookies.admin, { fresh: true })
    expect(momentoCalls.at(-1)!.body.fresh).toBe(true)
  })

  it('lists the projects started from the album', async () => {
    const list = (cookie: string) => realFetch(`${base}/api/albums/${ALBUM}/momento/projects`, {
      headers: { cookie, 'X-Requested-With': 'photos-share' }
    })
    expect((await list(cookies.friend)).status).toBe(403)

    const res = await list(cookies.admin)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      projects: [{ id: 'Xy7', title: 'Photo book', updatedAt: '2026-10-05T10:00:00Z', photoCount: 12, coverUrl: 'https://momento.example.com/blob/c.webp', url: 'https://momento.example.com/app/drafts/Xy7' }]
    })
    const call = momentoCalls.at(-1)!
    expect(call.headers['X-Momento-Service-Key']).toBe('service-secret')
    expect(call.body).toEqual({ immichAlbumId: ALBUM, ownerEmail: 'daniel@example.com' })
  })

  it('opens a chosen project, or starts a named new one', async () => {
    await open(cookies.admin, { draftId: 'Xy7' })
    expect(momentoCalls.at(-1)!.body).toMatchObject({ draftId: 'Xy7', fresh: false })

    await open(cookies.admin, { fresh: true, title: '  Wall poster  ' })
    expect(momentoCalls.at(-1)!.body).toMatchObject({ fresh: true, title: 'Wall poster' })

    // Junk ids are dropped rather than forwarded
    await open(cookies.admin, { draftId: '../../x' })
    expect(momentoCalls.at(-1)!.body.draftId).toBeUndefined()
  })

  it('turns Momento failures into a friendly error', async () => {
    momentoStatus = 502
    const res = await open(cookies.admin)
    expect(res.status).toBe(502)
    expect((await res.json()).error).toMatch(/couldn't read this album/)
    momentoStatus = 200
  })
})
