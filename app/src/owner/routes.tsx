import express from 'express'
import QRCode from 'qrcode'
import { apiUrl } from '../immich'
import { renderPage } from '../view/render'
import { ThemeScript } from '../view/theme'
import { ASSET_VERSION } from '../version'
import { jsonForInlineScript } from '../utils/text'
import { log } from '../utils/log'
import { asyncHandler } from '../http'
import { immichCall } from '../upload/immichAdmin'
import { maxUploadBytes, uploadsEnabled } from '../upload/server'
import { clientIp } from '../upload/validate'
import {
  COOKIE_NAME,
  createSession,
  deleteSession,
  getSession,
  loginAllowed,
  OwnerSession,
  recordLoginFailure
} from './session'

/*
  Owner area at /owner: sign in with your Immich account to create albums,
  make share links and add photos without opening Immich itself.

  Auth is Immich's own password check. The browser only ever holds a random
  session id (HttpOnly, Secure, SameSite=Strict). State-changing calls also
  require a custom header, which cross-site forms can't send.
*/

interface ImmichAlbum {
  id: string
  albumName: string
  assetCount: number
  albumThumbnailAssetId: string | null
  startDate?: string
  endDate?: string
  updatedAt?: string
}

interface ImmichSharedLink {
  id: string
  key: string
  slug: string | null
  type: string
  allowUpload: boolean
  allowDownload: boolean
  password?: string | null
  expiresAt: string | null
  album?: { id: string }
}

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/

declare module 'express-serve-static-core' {
  interface Request {
    owner?: OwnerSession
    ownerSid?: string
  }
}

function publicBase (req: express.Request): string {
  return (process.env.PUBLIC_BASE_URL || (req.protocol + '://' + req.headers.host)).replace(/\/+$/, '')
}

function linkUrl (req: express.Request, link: ImmichSharedLink): string {
  return publicBase(req) + (link.slug ? '/s/' + encodeURIComponent(link.slug) : '/share/' + link.key)
}

function readSid (req: express.Request): string | undefined {
  const header = req.headers.cookie || ''
  const match = header.split(/;\s*/).find(c => c.startsWith(COOKIE_NAME + '='))
  return match ? decodeURIComponent(match.slice(COOKIE_NAME.length + 1)) : undefined
}

function setSidCookie (res: express.Response, sid: string, maxAgeMs: number) {
  res.cookie(COOKIE_NAME, sid, {
    httpOnly: true,
    secure: process.env.OWNER_COOKIE_INSECURE !== 'true',
    sameSite: 'strict',
    path: '/',
    maxAge: maxAgeMs
  })
}

function loadOwner (req: express.Request, _res: express.Response, next: express.NextFunction) {
  const sid = readSid(req)
  const session = getSession(sid)
  if (session) {
    req.owner = session
    req.ownerSid = sid
  }
  next()
}

function requireApi (req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!req.owner) {
    res.status(401).json({ error: 'Please sign in again' })
    return
  }
  if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'photos-share') {
    res.status(403).json({ error: 'Bad request' })
    return
  }
  next()
}

/** Which way the request reached us: the LAN gateway (home Wi-Fi) or Cloudflare. Display only. */
export function laneOf (req: { headers: Record<string, string | string[] | undefined> }): 'lan' | 'internet' {
  return req.headers['x-photos-lane'] === 'lan' && !req.headers['cf-ray'] ? 'lan' : 'internet'
}

function Shell (props: { title: string, children?: preact.ComponentChildren, init?: object }) {
  return (
    <html lang="en">
      <head>
        <ThemeScript/>
        <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
        <meta name="robots" content="noindex"/>
        <title>{props.title}</title>
        <link rel="icon" href="/share/static/favicon.ico" type="image/x-icon"/>
        <link type="text/css" rel="stylesheet" href={`/share/static/${ASSET_VERSION}/style.css`}/>
      </head>
      <body class="owner">
        {props.children}
        {props.init && <>
          <script type="application/json" id="owner-init" dangerouslySetInnerHTML={{ __html: jsonForInlineScript(props.init) }}/>
          <script src="/share/static/vendor/tus.min.js"></script>
          <script type="module" src={`/share/static/${ASSET_VERSION}/js/client/owner.js`}></script>
        </>}
      </body>
    </html>
  )
}

function LoginPage (props: { error?: string }) {
  return (
    <Shell title="Sign in · Photos">
      <main class="owner-login">
        <form method="post" action="/owner/login">
          <h1>Photos</h1>
          <p>Sign in with your Immich account to manage albums and add photos.</p>
          {props.error && <p class="form-error" role="alert">{props.error}</p>}
          <label>Email<input name="email" type="email" autoComplete="username" required/></label>
          <label>Password<input name="password" type="password" autoComplete="current-password" required/></label>
          <button class="btn-primary" type="submit">Sign in</button>
        </form>
      </main>
    </Shell>
  )
}

function Dashboard (props: { name: string, lane: 'lan' | 'internet', maxBytes: number, uploads: boolean }) {
  return (
    <Shell title="Your albums · Photos" init={{ name: props.name, lane: props.lane, maxBytes: props.maxBytes, uploads: props.uploads }}>
      <header id="header">
        <div class="header-text">
          <h1>Your albums</h1>
          <p class="subtitle">
            Signed in as {props.name} · {props.lane === 'lan'
            ? <span class="lane lane-lan">⚡ direct on home Wi-Fi</span>
            : <span class="lane">via the internet</span>}
          </p>
        </div>
        <div class="header-actions">
          <button id="new-album" class="btn-primary" type="button">New album</button>
          <form method="post" action="/owner/logout"><button class="btn-link" type="submit">Sign out</button></form>
        </div>
      </header>
      <section id="albums" aria-live="polite"><p class="muted">Loading…</p></section>

      <dialog id="album-dialog" aria-labelledby="album-dialog-title">
        <form id="album-form" method="dialog">
          <h2 id="album-dialog-title">New album</h2>
          <input id="album-name" type="text" required maxLength={120} placeholder="e.g. Kericho Escapades" autoComplete="off"/>
          <div class="dialog-actions">
            <button class="btn-primary" type="submit">Create</button>
            <button class="btn-link" type="button" data-close>Cancel</button>
          </div>
        </form>
      </dialog>

      <dialog id="owner-share-dialog" aria-labelledby="owner-share-title">
        <form id="owner-share-form" method="dialog">
          <h2 id="owner-share-title">Share album</h2>
          <div class="qr" id="owner-share-qr"></div>
          <input id="owner-share-url" type="text" readOnly aria-label="Album link"/>
          <label class="check"><input id="share-allow-upload" type="checkbox" checked/> Friends can add photos</label>
          <label class="check"><input id="share-allow-download" type="checkbox" checked/> Friends can download</label>
          <label>Short link <span class="muted">(optional)</span>
            <span class="slug-row"><span class="muted">/s/</span><input id="share-slug" type="text" pattern="[a-z0-9-]{3,40}" placeholder="kericho" autoCapitalize="none" autoComplete="off"/></span>
          </label>
          <p class="form-error" id="owner-share-error" hidden></p>
          <div class="dialog-actions">
            <button class="btn-primary" type="submit" id="owner-share-save">Save</button>
            <button class="btn-link" type="button" id="owner-share-copy">Copy link</button>
            <button class="btn-link" type="button" data-close>Close</button>
          </div>
        </form>
      </dialog>

      <input type="file" id="upload-input" accept="image/*,video/*" multiple hidden/>
      <input type="file" id="folder-input" multiple hidden {...{ webkitdirectory: '' }}/>
      <section id="upload-panel" hidden aria-live="polite">
        <div class="upload-head">
          <strong id="upload-title">Adding photos…</strong>
          <span class="upload-who">to <span id="upload-album"></span> · <span id="upload-lane"></span></span>
        </div>
        <div class="upload-bar"><div id="upload-bar-fill"></div></div>
        <p id="upload-hint">Keep this page open until it's finished.</p>
        <ul id="upload-list"></ul>
        <div class="dialog-actions">
          <button id="upload-view" class="btn-primary" type="button" hidden>Done</button>
        </div>
      </section>
    </Shell>
  )
}

export function ownerRouter (): express.Router {
  const router = express.Router()
  // Scoped to /owner: share pages and photos must keep their cache headers.
  router.use('/owner', loadOwner)
  router.use('/owner', (_req, res, next) => {
    res.set('Cache-Control', 'no-store')
    res.set('X-Robots-Tag', 'noindex')
    next()
  })

  router.get('/owner', (req, res) => {
    if (!req.owner) {
      res.send(renderPage(<LoginPage/>))
      return
    }
    res.send(renderPage(<Dashboard name={req.owner.name} lane={laneOf(req)} maxBytes={maxUploadBytes()} uploads={uploadsEnabled()}/>))
  })

  router.post('/owner/login', asyncHandler(async (req, res) => {
    const ip = clientIp({ get: (h: string) => (req.headers[h] as string) || null }, req.socket.remoteAddress || '')
    if (!loginAllowed(ip)) {
      res.status(429).send(renderPage(<LoginPage error="Too many attempts. Try again in 15 minutes."/>))
      return
    }
    const email = String(req.body?.email || '').trim()
    const password = String(req.body?.password || '')
    const r = await fetch(apiUrl() + '/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    })
    if (!r.ok) {
      recordLoginFailure(ip)
      log.warn('Owner login failed for ' + email + ' from ' + ip)
      res.status(401).send(renderPage(<LoginPage error="Email or password is incorrect."/>))
      return
    }
    const body = await r.json() as { accessToken: string, userId: string, name: string, userEmail: string }
    const { sid, maxAgeMs } = createSession({ token: body.accessToken, userId: body.userId, name: body.name || email, email: body.userEmail || email })
    setSidCookie(res, sid, maxAgeMs)
    log('Owner signed in: ' + email + ' from ' + ip)
    res.redirect(303, '/owner')
  }))

  router.post('/owner/logout', asyncHandler(async (req, res) => {
    const session = deleteSession(req.ownerSid)
    if (session) {
      await fetch(apiUrl() + '/auth/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + session.token } }).catch(() => {})
    }
    res.clearCookie(COOKIE_NAME, { path: '/' })
    res.redirect(303, '/owner')
  }))

  // ----- JSON API (used by owner.js) -----

  router.use('/owner/api', requireApi)
  const auth = (req: express.Request) => ({ bearer: (req.owner as OwnerSession).token })

  const handleImmichError = (res: express.Response, e: unknown) => {
    const status = (e as { status?: number }).status
    if (status === 401) {
      res.status(401).json({ error: 'Please sign in again' })
      return
    }
    log.error('Owner API error: ' + e)
    res.status(502).json({ error: 'Immich request failed' })
  }

  router.get('/owner/api/albums', asyncHandler(async (req, res) => {
    try {
      const [albums, links] = await Promise.all([
        immichCall<ImmichAlbum[]>('GET', '/albums', undefined, auth(req)),
        immichCall<ImmichSharedLink[]>('GET', '/shared-links', undefined, auth(req))
      ])
      const byAlbum = new Map<string, ImmichSharedLink>()
      for (const l of links) if (l.album?.id && !byAlbum.has(l.album.id)) byAlbum.set(l.album.id, l)
      albums.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
      res.json(albums.map(a => {
        const link = byAlbum.get(a.id)
        return {
          id: a.id,
          name: a.albumName,
          count: a.assetCount,
          cover: a.albumThumbnailAssetId ? '/owner/thumb/' + a.albumThumbnailAssetId : null,
          link: link
            ? { id: link.id, url: linkUrl(req, link), slug: link.slug, allowUpload: link.allowUpload, allowDownload: link.allowDownload, hasPassword: !!link.password }
            : null
        }
      }))
    } catch (e) { handleImmichError(res, e) }
  }))

  router.post('/owner/api/albums', asyncHandler(async (req, res) => {
    const name = String(req.body?.name || '').trim().slice(0, 120)
    if (!name) {
      res.status(400).json({ error: 'Give the album a name' })
      return
    }
    try {
      const album = await immichCall<ImmichAlbum>('POST', '/albums', { albumName: name }, auth(req))
      res.json({ id: album.id })
    } catch (e) { handleImmichError(res, e) }
  }))

  // Create or update the album's share link
  router.post('/owner/api/albums/:id/share', asyncHandler(async (req, res) => {
    const albumId = req.params.id
    const slugRaw = String(req.body?.slug ?? '').trim().toLowerCase()
    if (slugRaw && !SLUG_RE.test(slugRaw)) {
      res.status(400).json({ error: 'Short link: 3-40 lowercase letters, numbers or dashes' })
      return
    }
    const settings = {
      allowUpload: req.body?.allowUpload !== false,
      allowDownload: req.body?.allowDownload !== false,
      showMetadata: true,
      slug: slugRaw || null
    }
    try {
      const links = await immichCall<ImmichSharedLink[]>('GET', '/shared-links?albumId=' + encodeURIComponent(albumId), undefined, auth(req))
      const existing = links.find(l => l.album?.id === albumId)
      const link = existing
        ? await immichCall<ImmichSharedLink>('PATCH', '/shared-links/' + existing.id, settings, auth(req))
        : await immichCall<ImmichSharedLink>('POST', '/shared-links', { type: 'ALBUM', albumId, ...settings }, auth(req))
      const url = linkUrl(req, link)
      const qrSvg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' })
      res.json({ url, qrSvg, slug: link.slug, allowUpload: link.allowUpload, allowDownload: link.allowDownload })
    } catch (e) {
      const msg = String(e)
      if (msg.includes('-> 400') && settings.slug) {
        res.status(400).json({ error: 'That short link is already taken' })
        return
      }
      handleImmichError(res, e)
    }
  }))

  // Album cover thumbnails, fetched with the owner's own token
  router.get('/owner/thumb/:id', asyncHandler(async (req, res) => {
    if (!req.owner || !/^[0-9a-f-]{36}$/.test(req.params.id)) {
      res.status(404).end()
      return
    }
    const r = await fetch(apiUrl() + '/assets/' + req.params.id + '/thumbnail?size=thumbnail', {
      headers: { Authorization: 'Bearer ' + req.owner.token }
    })
    if (!r.ok || !r.body) {
      res.status(404).end()
      return
    }
    res.set('Content-Type', r.headers.get('content-type') || 'image/webp')
    res.set('Cache-Control', 'private, max-age=3600')
    res.send(Buffer.from(await r.arrayBuffer()))
  }))

  return router
}
