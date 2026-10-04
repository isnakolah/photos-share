import express from 'express'
import QRCode from 'qrcode'
import { apiUrl, getShareByKey, invalidateShare, isKey } from '../immich'
import { renderPage } from '../view/render'
import { AuthPage, InviteInfo, MessagePage } from '../view/auth'
import { AlbumCard, Home } from '../view/home'
import { log } from '../utils/log'
import { asyncHandler } from '../http'
import { albumLinks, rememberAlbumLink } from '../attribution/db'
import { immichCall } from '../upload/immichAdmin'
import { clientIp } from '../upload/validate'
import { KeyType, SharedLink } from '../types'
import { AlbumInfo, albumForUser, albumOwner, albumPeople, GateViews, roleIn } from './access'
import {
  Account,
  COOKIE_NAME,
  createSession,
  deleteSession,
  loginAllowed,
  recordLoginFailure,
  recordSignup,
  signupAllowed
} from './session'

/*
  Accounts: sign in, create an account from an invite, the albums home page,
  and the small JSON API the pages use (create album, invite settings).
*/

interface ImmichAlbumListItem extends AlbumInfo {
  updatedAt?: string
}

interface ImmichSharedLink {
  id: string
  key: string
  slug: string | null
  allowUpload: boolean
  allowDownload: boolean
  album?: { id: string }
}

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Only same-site paths are allowed as post-login destinations. */
export function safeNext (next: unknown): string {
  const s = String(next || '')
  return s.startsWith('/') && !s.startsWith('//') && !s.startsWith('/\\') ? s : '/'
}

function ipOf (req: express.Request): string {
  return clientIp({ get: (h: string) => (req.headers[h] as string) || null }, req.socket.remoteAddress || '')
}

function setSidCookie (res: express.Response, sid: string, maxAgeMs: number) {
  res.cookie(COOKIE_NAME, sid, {
    httpOnly: true,
    secure: process.env.COOKIE_INSECURE !== 'true',
    // Lax, not Strict: people arrive from invite links in WhatsApp etc.
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeMs
  })
}

export function publicBase (req: express.Request): string {
  return (process.env.PUBLIC_BASE_URL || (req.protocol + '://' + req.headers.host)).replace(/\/+$/, '')
}

export function linkPath (link: { key: string, slug?: string | null }): string {
  return link.slug ? '/s/' + encodeURIComponent(link.slug) : '/share/' + link.key
}

async function inviteInfo (link: SharedLink, key: string, keyType: KeyType): Promise<InviteInfo> {
  const album = link.album as (SharedLink['album'] & Partial<Pick<AlbumInfo, 'albumUsers'>>) | undefined
  // Share-link lookups hide album members, so ask with the host's key
  let ownerName = albumOwner(album)?.name
  if (!ownerName && album?.id) {
    ownerName = await immichCall<AlbumInfo>('GET', '/albums/' + album.id + '?withoutAssets=true')
      .then(a => albumOwner(a)?.name).catch(() => undefined)
  }
  return {
    albumName: album?.albumName || link.description || 'A shared album',
    ownerName: ownerName || process.env.OWNER_NAME || 'A friend',
    count: album?.assetCount ?? link.assets?.length ?? 0,
    key,
    keyType: keyType === KeyType.slug ? 'slug' : 'key'
  }
}

/** Views the album gate renders (invite, not found, join failed). */
export const gateViews: GateViews = {
  invite: (req, res, link) => {
    const m = req.path.match(/^\/(share|s)\/([\w-]+)/)
    const keyType = m?.[1] === 's' ? KeyType.slug : KeyType.key
    inviteInfo(link, m?.[2] || link.key, keyType).then(invite => {
      res.set('Cache-Control', 'no-store')
      res.send(renderPage(<AuthPage next={req.path} invite={invite} tab={req.query.tab === 'login' ? 'login' : 'signup'}/>))
    }).catch(() => res.status(500).end())
  },
  notFound: (_req, res) => {
    res.status(404).set('Cache-Control', 'no-store').send(renderPage(
      <MessagePage sticker="Link not found" title="This link doesn't open anything"
                   body="It may have been switched off or typed wrong. Ask whoever sent it for a fresh one."
                   action={{ href: '/', label: 'Go to your albums' }}/>))
  },
  joinFailed: (_req, res) => {
    res.status(403).set('Cache-Control', 'no-store').send(renderPage(
      <MessagePage sticker="Hmm" title="You couldn't be added to this album"
                   body="Something went wrong on our side. Try opening the link again in a minute."
                   action={{ href: '/', label: 'Go to your albums' }}/>))
  }
}

export function notFoundPage (res: express.Response): void {
  gateViews.notFound({} as express.Request, res)
}

async function signIn (email: string, password: string): Promise<Account | null> {
  const r = await fetch(apiUrl() + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  })
  if (!r.ok) return null
  const b = await r.json() as { accessToken: string, userId: string, name: string, userEmail: string, isAdmin: boolean }
  return { token: b.accessToken, userId: b.userId, name: b.name || email, email: b.userEmail || email, isAdmin: !!b.isAdmin }
}

export function accountRouter (): express.Router {
  const router = express.Router()
  const noStore = (_req: express.Request, res: express.Response, next: express.NextFunction) => {
    res.set('Cache-Control', 'no-store')
    next()
  }

  // ----- auth pages -----------------------------------------------------------

  router.get('/login', noStore, (req, res) => {
    if (req.account) {
      res.redirect(303, safeNext(req.query.next))
      return
    }
    res.send(renderPage(<AuthPage next={safeNext(req.query.next)} tab="login"/>))
  })

  // Old owner area URL
  router.get('/owner', (_req, res) => { res.redirect(301, '/') })

  /** Re-render the invite (or plain sign-in) page with an error message. */
  const authError = async (req: express.Request, res: express.Response, status: number, tab: 'signup' | 'login', error: string) => {
    const next = safeNext(req.body?.next)
    let invite: InviteInfo | undefined
    const m = next.match(/^\/(share|s)\/([\w-]+)\/?$/)
    if (m) {
      const keyType = m[1] === 's' ? KeyType.slug : KeyType.key
      const share = await getShareByKey(m[2], undefined, keyType).catch(() => null)
      if (share?.valid && share.link?.album) invite = await inviteInfo(share.link, m[2], keyType)
    }
    res.status(status).set('Cache-Control', 'no-store').send(renderPage(
      <AuthPage next={next} invite={invite} tab={tab} error={error}
                values={{ name: String(req.body?.name || ''), email: String(req.body?.email || '') }}/>))
  }

  router.post('/login', noStore, asyncHandler(async (req, res) => {
    const ip = ipOf(req)
    if (!loginAllowed(ip)) {
      await authError(req, res, 429, 'login', 'Too many tries. Wait 15 minutes, then try again.')
      return
    }
    const email = String(req.body?.email || '').trim().toLowerCase()
    const account = await signIn(email, String(req.body?.password || ''))
    if (!account) {
      recordLoginFailure(ip)
      log.warn('Sign-in failed for ' + email + ' from ' + ip)
      await authError(req, res, 401, 'login', 'That email and password don\'t match.')
      return
    }
    const { sid, maxAgeMs } = createSession(account)
    setSidCookie(res, sid, maxAgeMs)
    log('Signed in: ' + email + ' from ' + ip)
    res.redirect(303, safeNext(req.body?.next))
  }))

  router.post('/signup', noStore, asyncHandler(async (req, res) => {
    const ip = ipOf(req)
    const name = String(req.body?.name || '').replace(/\s+/g, ' ').trim().slice(0, 40)
    const email = String(req.body?.email || '').trim().toLowerCase()
    const password = String(req.body?.password || '')
    const inviteKey = String(req.body?.invite || '')
    const inviteType = req.body?.inviteType === 'slug' ? KeyType.slug : KeyType.key

    if (!signupAllowed(ip)) {
      await authError(req, res, 429, 'signup', 'Too many new accounts from this network today. Try again tomorrow.')
      return
    }
    // Accounts can only be created from a valid invite
    const share = isKey(inviteKey) ? await getShareByKey(inviteKey, undefined, inviteType).catch(() => null) : null
    if (!share?.valid || !share.link?.album?.id) {
      await authError(req, res, 403, 'signup', 'This invite link no longer works. Ask for a new one.')
      return
    }
    if (!name) return authError(req, res, 400, 'signup', 'Add your name so friends know who you are.')
    if (!EMAIL_RE.test(email)) return authError(req, res, 400, 'signup', 'That email address doesn\'t look right.')
    if (password.length < 8) return authError(req, res, 400, 'signup', 'Use a password with at least 8 characters.')

    try {
      await immichCall('POST', '/admin/users', {
        email,
        password,
        name,
        shouldChangePassword: false,
        quotaSizeInBytes: process.env.FRIEND_QUOTA_GB ? Number(process.env.FRIEND_QUOTA_GB) * 1024 ** 3 : null
      })
    } catch (e) {
      const status = (e as { status?: number }).status
      if (status === 400 || status === 409) {
        await authError(req, res, 409, 'login', 'You already have an account with that email. Sign in instead.')
        return
      }
      log.error('Sign-up failed for ' + email + ': ' + e)
      await authError(req, res, 502, 'signup', 'Couldn\'t create your account just now. Try again in a minute.')
      return
    }
    recordSignup(ip)
    const account = await signIn(email, password)
    if (!account) {
      await authError(req, res, 502, 'login', 'Your account is ready. Sign in to continue.')
      return
    }
    const { sid, maxAgeMs } = createSession(account)
    setSidCookie(res, sid, maxAgeMs)
    log('New account: ' + email + ' (' + name + ') from ' + ip + ' via album ' + share.link.album.id)
    // The album gate adds them to the album when they land on the invite
    res.redirect(303, safeNext(req.body?.next))
  }))

  router.post('/logout', asyncHandler(async (req, res) => {
    const session = deleteSession(req.accountSid)
    if (session) {
      await fetch(apiUrl() + '/auth/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + session.token } }).catch(() => {})
    }
    res.clearCookie(COOKIE_NAME, { path: '/' })
    res.redirect(303, '/login')
  }))

  // ----- home -------------------------------------------------------------------

  router.get('/', noStore, asyncHandler(async (req, res) => {
    const account = req.account
    if (!account) {
      res.redirect(303, '/login')
      return
    }
    const auth = { bearer: account.token }
    let owned: ImmichAlbumListItem[] = []
    let shared: ImmichAlbumListItem[] = []
    try {
      [owned, shared] = await Promise.all([
        immichCall<ImmichAlbumListItem[]>('GET', '/albums?isOwned=true', undefined, auth),
        immichCall<ImmichAlbumListItem[]>('GET', '/albums?isOwned=false', undefined, auth)
      ])
    } catch (e) {
      if ((e as { status?: number }).status === 401) {
        deleteSession(req.accountSid)
        res.redirect(303, '/login')
        return
      }
      throw e
    }
    // Refresh invite links for the albums this person owns
    if (owned.length) {
      const links = await immichCall<ImmichSharedLink[]>('GET', '/shared-links', undefined, auth).catch(() => [])
      for (const l of links) if (l.album?.id) rememberAlbumLink(l.album.id, l.key, l.slug)
    }
    const links = albumLinks([...owned, ...shared].map(a => a.id))
    const card = (a: ImmichAlbumListItem): AlbumCard => {
      const link = links.get(a.id)
      const ownerName = albumOwner(a)?.name || 'A friend'
      return {
        id: a.id,
        name: a.albumName,
        count: a.assetCount,
        ownerName,
        cover: a.albumThumbnailAssetId ? '/thumb/' + a.albumThumbnailAssetId : null,
        url: link ? linkPath({ key: link.shareKey, slug: link.slug }) : null,
        memberNames: albumPeople(a).map(u => u.name)
      }
    }
    const byRecent = (x: ImmichAlbumListItem, y: ImmichAlbumListItem) => String(y.updatedAt || '').localeCompare(String(x.updatedAt || ''))
    res.send(renderPage(
      <Home account={account} owned={owned.sort(byRecent).map(card)} shared={shared.sort(byRecent).map(card)} canCreate={account.isAdmin}/>
    ))
  }))

  // Album covers, fetched with the viewer's own token (private to them)
  router.get('/thumb/:id', asyncHandler(async (req, res) => {
    if (!req.account || !/^[0-9a-f-]{36}$/.test(req.params.id)) {
      res.status(404).end()
      return
    }
    const r = await fetch(apiUrl() + '/assets/' + req.params.id + '/thumbnail?size=thumbnail', {
      headers: { Authorization: 'Bearer ' + req.account.token }
    })
    if (!r.ok) {
      res.status(404).end()
      return
    }
    res.set('Content-Type', r.headers.get('content-type') || 'image/webp')
    res.set('Cache-Control', 'private, max-age=3600')
    res.send(Buffer.from(await r.arrayBuffer()))
  }))

  // ----- JSON API -----------------------------------------------------------------

  const api = express.Router()
  api.use((req, res, next) => {
    res.set('Cache-Control', 'no-store')
    if (!req.account) {
      res.status(401).json({ error: 'Please sign in again' })
      return
    }
    // Cross-site forms can't set custom headers
    if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'photos-share') {
      res.status(403).json({ error: 'Bad request' })
      return
    }
    next()
  })

  const failed = (res: express.Response, e: unknown) => {
    if ((e as { status?: number }).status === 401) {
      res.status(401).json({ error: 'Please sign in again' })
      return
    }
    log.error('API error: ' + e)
    res.status(502).json({ error: 'Something went wrong. Try again.' })
  }

  // Create an album together with its invite link, then open it
  api.post('/albums', asyncHandler(async (req, res) => {
    const account = req.account as Account
    if (!account.isAdmin) {
      res.status(403).json({ error: 'Only the host can create albums' })
      return
    }
    const name = String(req.body?.name || '').trim().slice(0, 120)
    if (!name) {
      res.status(400).json({ error: 'Give the album a name' })
      return
    }
    try {
      const auth = { bearer: account.token }
      const album = await immichCall<{ id: string }>('POST', '/albums', { albumName: name }, auth)
      const link = await immichCall<ImmichSharedLink>('POST', '/shared-links', {
        type: 'ALBUM', albumId: album.id, allowUpload: true, allowDownload: true, showMetadata: true
      }, auth)
      rememberAlbumLink(album.id, link.key, link.slug)
      res.json({ id: album.id, url: linkPath(link) })
    } catch (e) { failed(res, e) }
  }))

  // Invite settings: who can add/download, and the short link
  api.post('/albums/:id/invite', asyncHandler(async (req, res) => {
    const account = req.account as Account
    const albumId = req.params.id
    const album = await albumForUser(account, albumId)
    if (roleIn(album, account.userId) !== 'owner') {
      res.status(403).json({ error: 'Only the album owner can change the invite' })
      return
    }
    const slug = String(req.body?.slug ?? '').trim().toLowerCase()
    if (slug && !SLUG_RE.test(slug)) {
      res.status(400).json({ error: 'Short link: 3 to 40 lowercase letters, numbers or dashes' })
      return
    }
    const settings = {
      allowUpload: req.body?.allowUpload !== false,
      allowDownload: req.body?.allowDownload !== false,
      showMetadata: true,
      slug: slug || null
    }
    try {
      const auth = { bearer: account.token }
      const links = await immichCall<ImmichSharedLink[]>('GET', '/shared-links?albumId=' + encodeURIComponent(albumId), undefined, auth)
      const existing = links.find(l => l.album?.id === albumId)
      const link = existing
        ? await immichCall<ImmichSharedLink>('PATCH', '/shared-links/' + existing.id, settings, auth)
        : await immichCall<ImmichSharedLink>('POST', '/shared-links', { type: 'ALBUM', albumId, ...settings }, auth)
      rememberAlbumLink(albumId, link.key, link.slug)
      invalidateShare(link.key, link.slug, existing?.key, existing?.slug)
      const url = publicBase(req) + linkPath(link)
      const qrSvg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' })
      res.json({ url, path: linkPath(link), qrSvg, slug: link.slug, allowUpload: link.allowUpload, allowDownload: link.allowDownload })
    } catch (e) {
      if (String(e).includes('-> 400') && slug) {
        res.status(400).json({ error: 'That short link is taken. Try another.' })
        return
      }
      failed(res, e)
    }
  }))

  router.use('/api', api)
  return router
}
