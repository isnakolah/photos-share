import { log } from '../utils/log'

/*
  Momento (album designer) integration. An album is a collection of photos that
  can seed any number of Momento projects. Server to server, Photos lists an
  album's projects, opens one, or starts a new one; the projects' photos link
  to Immich, so nothing is copied. Configured with:
    MOMENTO_INTERNAL_URL  e.g. http://momento-api:5110 (docker network)
    MOMENTO_SERVICE_KEY   shared secret, same value as Momento's
*/

export interface MomentoOpenResult {
  draftId: string
  workspaceUrl: string
  existed: boolean
  imported: number
  skippedVideos: number
}

export interface MomentoProject {
  draftId: string
  title: string
  updatedAt: string
  photoCount: number
  coverUrl: string | null
  workspaceUrl: string
}

export class MomentoError extends Error {
  constructor (public readonly status: number, message: string) {
    super(message)
  }
}

export function momentoConfigured (): boolean {
  return !!(process.env.MOMENTO_INTERNAL_URL && process.env.MOMENTO_SERVICE_KEY)
}

async function callMomento (path: string, payload: unknown, timeoutMs: number): Promise<Response> {
  const base = (process.env.MOMENTO_INTERNAL_URL || '').replace(/\/+$/, '')
  try {
    return await fetch(base + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Momento-Service-Key': process.env.MOMENTO_SERVICE_KEY || ''
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs)
    })
  } catch (e) {
    log.error('Momento unreachable: ' + e)
    throw new MomentoError(503, 'Momento is not reachable right now.')
  }
}

/** The owner's Momento projects started from this album, most recently edited first. */
export async function listMomentoProjects (opts: { albumId: string, ownerEmail: string }): Promise<MomentoProject[]> {
  const res = await callMomento('/api/integrations/immich/projects', {
    immichAlbumId: opts.albumId,
    ownerEmail: opts.ownerEmail
  }, 15_000)
  const body = await res.json().catch(() => null) as MomentoProject[] | { error?: string } | null
  if (!res.ok || !Array.isArray(body)) {
    log.error(`Momento project list failed (${res.status}): ${(body as { error?: string } | null)?.error || ''}`)
    throw new MomentoError(res.status, res.status === 403
      ? 'Your Momento account isn\'t set up for this yet.'
      : 'Couldn\'t load your Momento projects. Try again.')
  }
  return body
}

/**
 * Open one of the album's projects (draftId), start a new one (fresh), or
 * reopen the most recent one (neither).
 */
export async function openMomentoDraft (opts: {
  albumId: string
  ownerEmail: string
  title?: string
  fresh: boolean
  draftId?: string
}): Promise<MomentoOpenResult> {
  // Big albums take a moment to link; still well under a minute
  const res = await callMomento('/api/integrations/immich/drafts', {
    immichAlbumId: opts.albumId,
    ownerEmail: opts.ownerEmail,
    title: opts.title,
    fresh: opts.fresh,
    draftId: opts.draftId
  }, 90_000)
  const body = await res.json().catch(() => ({})) as Partial<MomentoOpenResult> & { error?: string }
  if (!res.ok || !body.workspaceUrl || !body.draftId) {
    log.error(`Momento open failed (${res.status}): ${body.error || ''}`)
    const message = res.status === 403
      ? 'Your Momento account isn\'t set up for this yet.'
      : res.status === 404
        ? 'That Momento project no longer exists.'
        : res.status === 502
          ? 'Momento couldn\'t read this album from Photos.'
          : 'Momento couldn\'t open this album. Try again.'
    throw new MomentoError(res.status, message)
  }
  return body as MomentoOpenResult
}
