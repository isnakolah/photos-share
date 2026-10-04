import { GalleryItem, LightboxConfig, MetadataConfig, GroupByDateMode } from '../shared/types'
import { ASSET_VERSION } from '../version'
import { jsonForInlineScript } from '../utils/text'
import { Avatar, Head, Sticker, TopBar } from './layout'
import type { Account } from '../account/session'

export type { GalleryItem, LightboxConfig, MetadataConfig, GroupByDateMode }

export interface InviteProps {
  url: string
  qrSvg: string
  // Owner can change who may add/download and the short link
  canManage: boolean
  albumId: string
  slug: string
  allowUpload: boolean
  allowDownload: boolean
}

export interface GalleryProps {
  items: GalleryItem[]
  title: string
  description: string
  publicBaseUrl: string
  path: string
  showDownloadZip: boolean
  showTitle: boolean
  // Formatted "available until" date, or undefined when off / never expires.
  expiryDate?: string
  openItem?: number
  ogImageItem?: GalleryItem
  lightboxConfig: LightboxConfig
  metadataConfig: MetadataConfig
  groupByDate: GroupByDateMode | false
  metaBase?: string
  // photos-share
  account?: Account
  ownerName?: string
  members?: string[]
  totalCount?: number
  upload?: { albumId: string, maxBytes: number, lane?: 'lan' | 'internet' }
  invite?: InviteProps
  uploaders?: Array<{ name: string, count: number }>
  activeUploader?: string
  pagePath?: string
}

const Icon = {
  camera: <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4,4H7L9,2H15L17,4H20A2,2 0 0,1 22,6V18A2,2 0 0,1 20,20H4A2,2 0 0,1 2,18V6A2,2 0 0,1 4,4M12,7A5,5 0 0,0 7,12A5,5 0 0,0 12,17A5,5 0 0,0 17,12A5,5 0 0,0 12,7M12,9A3,3 0 0,1 15,12A3,3 0 0,1 12,15A3,3 0 0,1 9,12A3,3 0 0,1 12,9Z"/></svg>,
  folder: <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M10,4H4C2.89,4 2,4.89 2,6V18A2,2 0 0,0 4,20H20A2,2 0 0,0 22,18V8C22,6.89 21.1,6 20,6H12L10,4Z"/></svg>,
  invite: <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M15,14C12.33,14 7,15.33 7,18V20H23V18C23,15.33 17.67,14 15,14M6,10V7H4V10H1V12H4V15H6V12H9V10M15,12A4,4 0 0,0 19,8A4,4 0 0,0 15,4A4,4 0 0,0 11,8A4,4 0 0,0 15,12Z"/></svg>,
  download: <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M5,20H19V18H5M19,9H15V3H9V9H5L12,16L19,9Z"/></svg>,
  back: <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M15.41,16.58L10.83,12L15.41,7.41L14,6L8,12L14,18L15.41,16.58Z"/></svg>,
  close: <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z"/></svg>
}

export function Gallery (props: GalleryProps) {
  const initJson = jsonForInlineScript({
    items: props.items,
    openItem: props.openItem,
    lightboxConfig: props.lightboxConfig,
    metadataConfig: props.metadataConfig,
    groupByDate: props.groupByDate,
    metaBase: props.metaBase
  })
  const total = props.totalCount ?? props.items.length
  const members = props.members || []
  const others = members.length - 1
  const base = props.pagePath || props.path
  const albumTitle = props.title || 'Album'

  return (
    <html lang="en">
      <Head
        title={albumTitle + ' · Photos'}
        extraCss={['/share/static/photoswipe/photoswipe.css', `/share/static/${ASSET_VERSION}/photoswipe-overrides.css`]}
      />
      <body class="album-page">
        <TopBar account={props.account}/>

        <header class="container album-head">
          <a class="back-link" href="/">{Icon.back}<span>All albums</span></a>
          <div class="album-head-row">
            <div class="album-head-text">
              <h1 class="album-title-xl">{albumTitle}</h1>
              <div class="album-people">
                <span class="avatar-stack">{members.slice(0, 5).map(n => <Avatar name={n} size="sm"/>)}</span>
                <span class="album-by">
                  {props.ownerName ? `Started by ${props.ownerName}` : ''}
                  {others > 0 ? `, with ${others} ${others === 1 ? 'friend' : 'friends'}` : ''}
                </span>
              </div>
            </div>
            <span class="album-head-count">
              <Sticker tone="sun" tilt="right">{total} {total === 1 ? 'photo' : 'photos'}</Sticker>
            </span>
          </div>

          <div class="album-actions">
            {props.upload && <>
              <button id="add-photos" class="btn btn-primary btn-lg" type="button">{Icon.camera}<span>Add photos</span></button>
              <button id="add-folder" class="btn btn-ghost folder-btn" type="button">{Icon.folder}<span>Add a folder</span></button>
            </>}
            {props.invite && (
              <button id="share-open" class="btn btn-secondary" type="button">{Icon.invite}<span>Invite friends</span></button>
            )}
            {props.showDownloadZip && total > 0 && (
              <a id="download-zip" class="btn btn-ghost" href={props.path + '/download'} title="Download every photo as one ZIP file">
                {Icon.download}<span>Download all</span>
              </a>
            )}
          </div>

          {props.uploaders && props.uploaders.length > 1 && (
            <nav id="uploader-filter" aria-label="Show photos added by">
              <a href={base} class={props.activeUploader ? '' : 'active'} aria-current={props.activeUploader ? undefined : 'page'}>Everyone</a>
              {props.uploaders.map(u => (
                <a href={base + '?by=' + encodeURIComponent(u.name)}
                   class={props.activeUploader === u.name ? 'active' : ''}
                   aria-current={props.activeUploader === u.name ? 'page' : undefined}>
                  <Avatar name={u.name} size="xs" title=""/>{u.name}<span class="count">{u.count}</span>
                </a>
              ))}
            </nav>
          )}
        </header>

        {props.items.length === 0 && !props.activeUploader && (
          <section class="container">
            <div class="empty-state" id="empty-album">
              <Sticker tone="pink" tilt="left">Fresh album!</Sticker>
              <p class="empty-title">No photos here yet</p>
              <p>{props.upload ? 'Be the first. Tap Add photos and pick a few from your phone.' : 'Photos will show up here as people add them.'}</p>
            </div>
          </section>
        )}

        {/* Filled by the client virtualiser with just the tiles in view */}
        <div id="gallery"></div>

        {props.showDownloadZip && (
          <div id="select-toolbar" hidden>
            <button id="select-cancel" class="toolbar-btn" type="button" aria-label="Exit selection mode">{Icon.close}</button>
            <span id="select-count">0 selected</span>
            <button id="select-all" class="toolbar-btn-text" type="button">Select all</button>
            <button id="select-download" class="toolbar-btn" type="button" aria-label="Download selected">{Icon.download}</button>
          </div>
        )}

        {props.invite && (
          <dialog id="share-dialog" aria-labelledby="share-title">
            <form id="invite-form" method="dialog">
              <div class="dialog-head">
                <h2 id="share-title">Invite friends</h2>
                <button class="icon-btn" type="button" id="share-close" aria-label="Close">{Icon.close}</button>
              </div>
              <p class="dialog-sub">Anyone you send this to signs up once, then sees the album and adds their own photos.</p>
              <div class="qr" id="share-qr" dangerouslySetInnerHTML={{ __html: props.invite.qrSvg }}/>
              <div class="copy-row">
                <input id="share-url" type="text" readOnly value={props.invite.url} aria-label="Invite link"/>
                <button id="share-copy" class="btn btn-primary" type="button">Copy link</button>
              </div>
              {props.invite.canManage && (
                <fieldset class="invite-settings">
                  <legend>Invite settings</legend>
                  <label class="switch"><input id="invite-allow-upload" type="checkbox" checked={props.invite.allowUpload}/><span>New people can add photos</span></label>
                  <label class="switch"><input id="invite-allow-download" type="checkbox" checked={props.invite.allowDownload}/><span>People can download</span></label>
                  <label class="field">
                    <span>Short link</span>
                    <span class="slug-row"><span class="slug-prefix">/s/</span>
                      <input id="invite-slug" type="text" value={props.invite.slug} pattern="[a-z0-9-]{3,40}" placeholder="kericho" autoCapitalize="none" autoComplete="off"/>
                    </span>
                  </label>
                  <p class="form-error" id="invite-error" hidden></p>
                  <button class="btn btn-secondary" type="submit" id="invite-save" data-album={props.invite.albumId}>Save settings</button>
                </fieldset>
              )}
            </form>
          </dialog>
        )}

        {props.upload && <>
          <input type="file" id="upload-input" accept="image/*,video/*" multiple hidden/>
          <input type="file" id="folder-input" multiple hidden {...{ webkitdirectory: '' }}/>
          <section id="upload-panel" hidden aria-live="polite">
            <div class="upload-head">
              <strong id="upload-title">Adding photos…</strong>
              <span class="upload-lane" id="upload-lane">
                {props.upload.lane === 'lan' ? 'Direct over your home Wi-Fi' : 'Over the internet'}
              </span>
            </div>
            <div class="upload-bar"><div id="upload-bar-fill"></div></div>
            <p id="upload-hint">Keep this page open until it's finished.</p>
            <ul id="upload-list"></ul>
            <div class="dialog-actions">
              <button id="upload-view" class="btn btn-primary" type="button" hidden>See them in the album</button>
              <button id="upload-more" class="btn btn-ghost" type="button" hidden>Add more</button>
            </div>
          </section>
          <script type="application/json" id="ipp-upload" dangerouslySetInnerHTML={{ __html: jsonForInlineScript(props.upload) }}/>
          <script src="/share/static/vendor/tus.min.js"></script>
        </>}

        <script type="application/json" id="ipp-init" dangerouslySetInnerHTML={{ __html: initJson }}/>
        <script type="module" src={`/share/static/${ASSET_VERSION}/js/client/init.js`}></script>
        <script type="module" src={`/share/static/${ASSET_VERSION}/js/client/extras.js`}></script>
      </body>
    </html>
  )
}
