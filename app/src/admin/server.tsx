import crypto from 'crypto'
import express from 'express'
import { renderPage } from '../view/render'
import { Avatar, Page } from '../view/layout'
import { ASSET_VERSION } from '../version'
import { log } from '../utils/log'
import {
  removableByAlbum,
  listUploads,
  markDeleted,
  summaryByUploader,
  UploadRecord,
  UploaderSummary
} from '../attribution/db'
import { removeFromAlbum } from '../upload/immichAdmin'

/*
  Host-only admin page: who uploaded what, and "delete everything X added".

  Runs on its own port (ADMIN_PORT, default 3001) so it is never reachable
  through the public tunnel, which only forwards the main port. Compose
  publishes it on the LAN / Tailscale addresses only. ADMIN_PASSWORD adds
  HTTP basic auth on top.
*/

function formatBytes (n: number): string {
  if (n < 1024 ** 2) return Math.max(1, Math.round(n / 1024)) + ' KB'
  if (n < 1024 ** 3) return (n / 1024 ** 2).toFixed(1) + ' MB'
  return (n / 1024 ** 3).toFixed(2) + ' GB'
}

function when (iso: string): string {
  return iso.replace('T', ' ').slice(0, 16)
}

function immichLink (assetId: string | null): string | undefined {
  const base = (process.env.IMMICH_PUBLIC_URL || '').replace(/\/+$/, '')
  return base && assetId ? base + '/photos/' + assetId : undefined
}

interface AdminProps {
  summary: UploaderSummary[]
  uploads: UploadRecord[]
  uploader?: string
  message?: string
}

function AdminPage (props: AdminProps) {
  return (
    <Page title="Uploads · Photos admin" bodyClass="admin-page">
      <main class="container">
        <h1>Who added what</h1>
        <p class="muted">Every photo added through the app, by person. Only reachable on your home network.</p>
        {props.message && <p class="admin-message" role="status">{props.message}</p>}

        <h2>People</h2>
        <div class="admin-table-wrap">
          <table class="admin-table">
            <thead><tr><th>Name</th><th>Files</th><th>Size</th><th>Last added</th><th>Remove their uploads</th></tr></thead>
            <tbody>
              {props.summary.map(s => (
                <tr>
                  <td><a class="person" href={'?uploader=' + encodeURIComponent(s.uploader)}><Avatar name={s.uploader} size="sm"/>{s.uploader}</a></td>
                  <td>{s.count}</td>
                  <td>{formatBytes(s.bytes)}</td>
                  <td>{when(s.lastUpload)}</td>
                  <td>
                    <form method="post" action="delete" class="admin-remove">
                      <input type="hidden" name="uploader" value={s.uploader}/>
                      <input name="confirm" placeholder={'Type ' + s.uploader + ' to confirm'} aria-label={'Type ' + s.uploader + ' to confirm removing their uploads'}/>
                      <button class="btn btn-ghost" type="submit">Remove from albums</button>
                    </form>
                  </td>
                </tr>
              ))}
              {!props.summary.length && <tr><td colSpan={5} class="muted">Nobody has added photos through the app yet.</td></tr>}
            </tbody>
          </table>
        </div>

        <h2>{props.uploader ? <>Added by {props.uploader} (<a href=".">show everyone</a>)</> : 'Latest uploads'}</h2>
        <div class="admin-table-wrap">
          <table class="admin-table">
            <thead><tr><th>When</th><th>Who</th><th>Album</th><th>File</th><th>Size</th><th>Status</th><th>IP</th></tr></thead>
            <tbody>
              {props.uploads.map(u => {
                const link = immichLink(u.assetId)
                const status = u.deletedAt ? 'removed' : u.status === 'done' && u.duplicate ? 'duplicate' : u.status
                return (
                  <tr class={u.deletedAt ? 'is-removed' : ''}>
                    <td>{when(u.createdAt)}</td>
                    <td><span class="person"><Avatar name={u.uploader} size="xs" title=""/>{u.uploader}</span></td>
                    <td>{u.albumName}</td>
                    <td>{link ? <a href={link} target="_blank" rel="noreferrer">{u.filename}</a> : u.filename}</td>
                    <td>{formatBytes(u.size)}</td>
                    <td class={status === 'error' ? 'status-error' : ''} title={u.error || ''}>{status}</td>
                    <td title={u.userAgent}>{u.ip}</td>
                  </tr>
                )
              })}
              {!props.uploads.length && <tr><td colSpan={7} class="muted">No uploads yet.</td></tr>}
            </tbody>
          </table>
        </div>
        <p class="note">"Remove from albums" takes that person's uploads out of your albums. Their files stay in their own account, and photos that were already in the album are left alone.</p>
      </main>
    </Page>
  )
}

function basicAuth (password: string) {
  const expected = Buffer.from(password)
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const header = req.headers.authorization || ''
    const supplied = Buffer.from(header.startsWith('Basic ')
      ? Buffer.from(header.slice(6), 'base64').toString('utf8').split(':').slice(1).join(':')
      : '')
    if (supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected)) return next()
    res.set('WWW-Authenticate', 'Basic realm="photos-share admin"').status(401).send('Authentication required')
  }
}

export function createAdminApp (): express.Express {
  const app = express()
  app.disable('x-powered-by')
  // Refuse anything that came through Cloudflare, even if a port is misrouted
  app.use((req, res, next) => {
    if (req.headers['cf-connecting-ip'] || req.headers['cf-ray']) {
      res.status(404).end()
      return
    }
    next()
  })
  if (process.env.ADMIN_PASSWORD) app.use(basicAuth(process.env.ADMIN_PASSWORD))
  // Same stylesheet and fonts as the main app
  app.use('/share/static/' + ASSET_VERSION, express.static('public'))
  app.use('/share/static', express.static('public'))
  app.use(express.urlencoded({ extended: false }))

  app.get('/', (req, res) => {
    const uploader = typeof req.query.uploader === 'string' ? req.query.uploader : undefined
    res.set('Cache-Control', 'no-store')
    res.send(renderPage(
      <AdminPage
        summary={summaryByUploader()}
        uploads={listUploads({ uploader })}
        uploader={uploader}
        message={typeof req.query.msg === 'string' ? req.query.msg : undefined}
      />
    ))
  })

  app.post('/delete', async (req, res) => {
    const uploader = String(req.body?.uploader || '')
    const confirm = String(req.body?.confirm || '').trim()
    let msg: string
    if (!uploader || confirm !== uploader) {
      msg = 'Not deleted: type the name exactly to confirm.'
    } else {
      const byAlbum = removableByAlbum(uploader)
      const ids = [...byAlbum.values()].flat()
      try {
        for (const [albumId, assetIds] of byAlbum) await removeFromAlbum(albumId, assetIds)
        markDeleted(ids)
        msg = `Removed ${ids.length} file${ids.length === 1 ? '' : 's'} from ${uploader} from your albums.`
        log('Admin removed ' + ids.length + ' assets uploaded by ' + uploader + ' from albums')
      } catch (e) {
        msg = 'Delete failed: ' + (e instanceof Error ? e.message : String(e))
      }
    }
    res.redirect(303, '.?msg=' + encodeURIComponent(msg))
  })
  return app
}

export function startAdminServer (): void {
  const port = Number(process.env.ADMIN_PORT) || 3001
  if (process.env.ADMIN_PORT === '0') return
  createAdminApp().listen(port, () => log('Admin page on port ' + port))
}
