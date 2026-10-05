import { log } from '../utils/log'

/*
  Momento (album designer) integration. "Open in Momento" on an album asks
  Momento, server to server, to create or reopen an album design whose photos
  link to this Immich album (nothing is copied). Configured with:
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

export class MomentoError extends Error {
  constructor (public readonly status: number, message: string) {
    super(message)
  }
}

export function momentoConfigured (): boolean {
  return !!(process.env.MOMENTO_INTERNAL_URL && process.env.MOMENTO_SERVICE_KEY)
}

export async function openMomentoDraft (opts: {
  albumId: string
  ownerEmail: string
  title?: string
  fresh: boolean
}): Promise<MomentoOpenResult> {
  const base = (process.env.MOMENTO_INTERNAL_URL || '').replace(/\/+$/, '')
  let res: Response
  try {
    res = await fetch(base + '/api/integrations/immich/drafts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Momento-Service-Key': process.env.MOMENTO_SERVICE_KEY || ''
      },
      body: JSON.stringify({
        immichAlbumId: opts.albumId,
        ownerEmail: opts.ownerEmail,
        title: opts.title,
        fresh: opts.fresh
      }),
      // Big albums take a moment to link; still well under a minute
      signal: AbortSignal.timeout(90_000)
    })
  } catch (e) {
    log.error('Momento unreachable: ' + e)
    throw new MomentoError(503, 'Momento is not reachable right now.')
  }
  const body = await res.json().catch(() => ({})) as Partial<MomentoOpenResult> & { error?: string }
  if (!res.ok || !body.workspaceUrl || !body.draftId) {
    log.error(`Momento open failed (${res.status}): ${body.error || ''}`)
    const message = res.status === 403
      ? 'Your Momento account isn\'t set up for this yet.'
      : res.status === 502
        ? 'Momento couldn\'t read this album from Photos.'
        : 'Momento couldn\'t open this album. Try again.'
    throw new MomentoError(res.status, message)
  }
  return body as MomentoOpenResult
}
