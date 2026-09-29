import crypto from 'crypto'
import express from 'express'
import { renderPage } from '../view/render'
import { log } from '../utils/log'
import {
  deletableAssetsFor,
  listUploads,
  markDeleted,
  summaryByUploader,
  UploadRecord,
  UploaderSummary
} from '../attribution/db'
import { trashAssets } from '../upload/immichAdmin'

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
    <html lang="en">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
        <title>Uploads · photos-share</title>
        <style dangerouslySetInnerHTML={{ __html: ADMIN_CSS }}/>
      </head>
      <body>
        <h1>Guest uploads</h1>
        {props.message && <p class="message">{props.message}</p>}
        <h2>By person</h2>
        <table>
          <thead><tr><th>Name</th><th>Files</th><th>Size</th><th>Last upload</th><th></th></tr></thead>
          <tbody>
            {props.summary.map(s => (
              <tr>
                <td><a href={'?uploader=' + encodeURIComponent(s.uploader)}>{s.uploader}</a></td>
                <td>{s.count}</td>
                <td>{formatBytes(s.bytes)}</td>
                <td>{when(s.lastUpload)}</td>
                <td>
                  <form method="post" action="delete" class="delete">
                    <input type="hidden" name="uploader" value={s.uploader}/>
                    <input name="confirm" placeholder={'type "' + s.uploader + '" to delete'} aria-label={'Confirm deleting uploads by ' + s.uploader}/>
                    <button type="submit">Move all to trash</button>
                  </form>
                </td>
              </tr>
            ))}
            {!props.summary.length && <tr><td colSpan={5}>No guest uploads yet.</td></tr>}
          </tbody>
        </table>
        <h2>
          {props.uploader ? <>Uploads by {props.uploader} · <a href=".">show everyone</a></> : 'Recent uploads'}
        </h2>
        <table>
          <thead><tr><th>When</th><th>Who</th><th>Album</th><th>File</th><th>Size</th><th>Status</th><th>IP</th></tr></thead>
          <tbody>
            {props.uploads.map(u => {
              const link = immichLink(u.assetId)
              const status = u.deletedAt ? 'trashed' : u.status === 'done' && u.duplicate ? 'duplicate' : u.status
              return (
                <tr class={'status-' + status}>
                  <td>{when(u.createdAt)}</td>
                  <td>{u.uploader}</td>
                  <td>{u.albumName}</td>
                  <td>{link ? <a href={link} target="_blank" rel="noreferrer">{u.filename}</a> : u.filename}</td>
                  <td>{formatBytes(u.size)}</td>
                  <td title={u.error || ''}>{status}</td>
                  <td title={u.userAgent}>{u.ip}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <p class="note">"Move all to trash" skips files that already existed in Immich (duplicates). Trashed files can be restored from Immich's trash.</p>
      </body>
    </html>
  )
}

const ADMIN_CSS = `
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { margin: 0 auto; padding: 16px; max-width: 1100px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 24px; font-size: 14px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid color-mix(in srgb, currentColor 15%, transparent); vertical-align: middle; }
  .delete { display: flex; gap: 6px; flex-wrap: wrap; }
  .delete input { min-width: 12em; }
  .message { padding: 8px 12px; border-radius: 8px; background: color-mix(in srgb, #4250af 20%, transparent); }
  .status-error td:nth-child(6) { color: #d33; }
  .status-trashed { opacity: 0.5; }
  .note { opacity: 0.7; font-size: 13px; }
  @media (max-width: 700px) { td:nth-child(7), th:nth-child(7) { display: none; } }
`

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
      const ids = deletableAssetsFor(uploader)
      try {
        if (ids.length) await trashAssets(ids)
        markDeleted(ids)
        msg = `Moved ${ids.length} file${ids.length === 1 ? '' : 's'} from ${uploader} to Immich's trash.`
        log('Admin trashed ' + ids.length + ' assets uploaded by ' + uploader)
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
