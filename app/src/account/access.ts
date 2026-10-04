import express from 'express'
import { getShareByKey } from '../immich'
import { KeyType, SharedLink } from '../types'
import { log } from '../utils/log'
import { rememberAlbumLink } from '../attribution/db'
import { immichCall } from '../upload/immichAdmin'
import { TtlLruCache } from '../utils/ttlLruCache'
import { Account, getSession, sidFromCookieHeader } from './session'

/*
  Access control for album pages and photos.

  A share link is an invite, not a key: every album page, photo, video,
  metadata and download route needs a signed-in account that is a member of
  the album (or its owner). Opening an invite while signed in adds you to the
  album; signed out, you get the "you're invited" page instead.
*/

export type AlbumRole = 'owner' | 'editor' | 'viewer'

/** Album as Immich v3 returns it: the owner is the albumUsers entry with role 'owner'. */
export interface AlbumInfo {
  id: string
  albumName: string
  assetCount: number
  albumThumbnailAssetId: string | null
  albumUsers: Array<{ user: { id: string, name: string }, role: AlbumRole }>
}

export function albumOwner (album: { albumUsers?: AlbumInfo['albumUsers'] } | null | undefined): { id: string, name: string } | undefined {
  return album?.albumUsers?.find(u => u.role === 'owner')?.user
}

/** Everyone in the album, owner first. */
export function albumPeople (album: { albumUsers?: AlbumInfo['albumUsers'] } | null | undefined): Array<{ id: string, name: string }> {
  const users = album?.albumUsers || []
  return [...users.filter(u => u.role === 'owner'), ...users.filter(u => u.role !== 'owner')]
    .map(u => u.user).filter(u => u?.id)
}

declare module 'express-serve-static-core' {
  interface Request {
    account?: Account
    accountSid?: string
  }
}

/** Attach the signed-in account (if any) to every request. */
export function loadAccount (req: express.Request, _res: express.Response, next: express.NextFunction) {
  const sid = sidFromCookieHeader(req.headers.cookie)
  const account = getSession(sid)
  if (account) {
    req.account = account
    req.accountSid = sid
  }
  next()
}

// Album lookups per (user, album), so the many photo requests of one gallery
// view don't each hit Immich. Null means "no access".
const albumCache = new TtlLruCache<Promise<AlbumInfo | null>>({ ttlMs: 120_000, max: 2000 })

export function albumForUser (account: Account, albumId: string): Promise<AlbumInfo | null> {
  const key = account.userId + ':' + albumId
  const hit = albumCache.get(key)
  if (hit) return hit
  const p = immichCall<AlbumInfo>('GET', '/albums/' + albumId + '?withoutAssets=true', undefined, { bearer: account.token })
    .catch(() => null)
  albumCache.set(key, p)
  return p
}

export function forgetAlbumAccess (userId: string, albumId: string): void {
  albumCache.delete(userId + ':' + albumId)
}

export function roleIn (album: AlbumInfo | null, userId: string): AlbumRole | null {
  return album?.albumUsers?.find(u => u.user?.id === userId)?.role || null
}

/** Add a user to an album, done with the host's API key (the album owner). */
export async function joinAlbum (albumId: string, userId: string, role: 'editor' | 'viewer'): Promise<void> {
  await immichCall('PUT', '/albums/' + albumId + '/users', { albumUsers: [{ userId, role }] })
  forgetAlbumAccess(userId, albumId)
}

type RouteKind = 'page' | 'download' | 'asset' | 'meta'

interface Classified {
  kind: RouteKind
  key: string
  keyType: KeyType
}

const RESERVED = new Set(['static', 'healthcheck', 'upload', 'unlock', 'photo', 'video', 'meta'])

/** Work out whether a path is one of the album routes, and which share it names. */
export function classify (path: string): Classified | null {
  let m = path.match(/^\/share\/(?:photo|video)\/([\w-]+)\//)
  if (m) return { kind: 'asset', key: m[1], keyType: KeyType.key }
  m = path.match(/^\/(share|s)\/meta\/([\w-]+)\//)
  if (m) return { kind: 'meta', key: m[2], keyType: m[1] === 's' ? KeyType.slug : KeyType.key }
  m = path.match(/^\/(share|s)\/([\w-]+)\/download\/?$/)
  if (m && !RESERVED.has(m[2])) return { kind: 'download', key: m[2], keyType: m[1] === 's' ? KeyType.slug : KeyType.key }
  m = path.match(/^\/(share|s)\/([\w-]+)\/?$/)
  if (m && !RESERVED.has(m[2])) return { kind: 'page', key: m[2], keyType: m[1] === 's' ? KeyType.slug : KeyType.key }
  return null
}

export interface GateViews {
  invite: (req: express.Request, res: express.Response, link: SharedLink) => void
  notFound: (req: express.Request, res: express.Response) => void
  joinFailed: (req: express.Request, res: express.Response) => void
}

/**
 * Express middleware guarding every album route. On success it leaves
 * `res.locals.album` and `res.locals.role` for the gallery view.
 */
export function albumGate (views: GateViews) {
  return async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const route = classify(req.path)
    if (!route) return next()
    try {
      const share = await getShareByKey(route.key, undefined, route.keyType)
      const link = share.valid ? share.link : undefined
      if (!link?.album?.id) {
        if (route.kind === 'page') return views.notFound(req, res)
        return res.status(404).end()
      }
      rememberAlbumLink(link.album.id, link.key, link.slug)

      const account = req.account
      if (!account) {
        if (route.kind === 'page') return views.invite(req, res, link)
        return res.status(404).end()
      }

      let album = await albumForUser(account, link.album.id)
      let role = roleIn(album, account.userId)
      if (!role && route.kind === 'page') {
        // Opening an invite while signed in: join the album
        try {
          await joinAlbum(link.album.id, account.userId, link.allowUpload ? 'editor' : 'viewer')
          log('Added ' + account.email + ' to album ' + (link.album.albumName || link.album.id))
        } catch (e) {
          log.error('Could not add ' + account.email + ' to album ' + link.album.id + ': ' + e)
          return views.joinFailed(req, res)
        }
        album = await albumForUser(account, link.album.id)
        role = roleIn(album, account.userId)
      }
      if (!role) {
        if (route.kind === 'page') return views.joinFailed(req, res)
        return res.status(404).end()
      }
      res.locals.album = album
      res.locals.role = role
      next()
    } catch (e) {
      next(e)
    }
  }
}
