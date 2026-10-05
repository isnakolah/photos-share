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
  albumId?: string
  account?: Account
  ownerName?: string
  members?: string[]
  totalCount?: number
  upload?: { albumId: string, maxBytes: number, lane?: 'lan' | 'internet' }
  invite?: InviteProps
  uploaders?: Array<{ name: string, count: number }>
  activeUploader?: string
  pagePath?: string
  // Viewer can delete at least one photo here / owns the album
  canDeleteAny?: boolean
  isOwner?: boolean
}

const Icon = {
  camera: <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4,4H7L9,2H15L17,4H20A2,2 0 0,1 22,6V18A2,2 0 0,1 20,20H4A2,2 0 0,1 2,18V6A2,2 0 0,1 4,4M12,7A5,5 0 0,0 7,12A5,5 0 0,0 12,17A5,5 0 0,0 17,12A5,5 0 0,0 12,7M12,9A3,3 0 0,1 15,12A3,3 0 0,1 12,15A3,3 0 0,1 9,12A3,3 0 0,1 12,9Z"/></svg>,
  folder: <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M10,4H4C2.89,4 2,4.89 2,6V18A2,2 0 0,0 4,20H20A2,2 0 0,0 22,18V8C22,6.89 21.1,6 20,6H12L10,4Z"/></svg>,
  invite: <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M15,14C12.33,14 7,15.33 7,18V20H23V18C23,15.33 17.67,14 15,14M6,10V7H4V10H1V12H4V15H6V12H9V10M15,12A4,4 0 0,0 19,8A4,4 0 0,0 15,4A4,4 0 0,0 11,8A4,4 0 0,0 15,12Z"/></svg>,
  download: <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M5,20H19V18H5M19,9H15V3H9V9H5L12,16L19,9Z"/></svg>,
  back: <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M15.41,16.58L10.83,12L15.41,7.41L14,6L8,12L14,18L15.41,16.58Z"/></svg>,
  select: <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12,2A10,10 0 0,1 22,12A10,10 0 0,1 12,22A10,10 0 0,1 2,12A10,10 0 0,1 12,2M11,16.5L18,9.5L16.59,8.09L11,13.67L7.91,10.59L6.5,12L11,16.5Z"/></svg>,
  trash: <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M9,3V4H4V6H5V19A2,2 0 0,0 7,21H17A2,2 0 0,0 19,19V6H20V4H15V3H9M7,6H17V19H7V6M9,8V17H11V8H9M13,8V17H15V8H13Z"/></svg>,
  settings: <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12,15.5A3.5,3.5 0 0,1 8.5,12A3.5,3.5 0 0,1 12,8.5A3.5,3.5 0 0,1 15.5,12A3.5,3.5 0 0,1 12,15.5M19.43,12.97C19.47,12.65 19.5,12.33 19.5,12C19.5,11.67 19.47,11.34 19.43,11L21.54,9.37C21.73,9.22 21.78,8.95 21.66,8.73L19.66,5.27C19.54,5.05 19.27,4.96 19.05,5.05L16.56,6.05C16.04,5.66 15.5,5.32 14.87,5.07L14.5,2.42C14.46,2.18 14.25,2 14,2H10C9.75,2 9.54,2.18 9.5,2.42L9.13,5.07C8.5,5.32 7.96,5.66 7.44,6.05L4.95,5.05C4.73,4.96 4.46,5.05 4.34,5.27L2.34,8.73C2.21,8.95 2.27,9.22 2.46,9.37L4.57,11C4.53,11.34 4.5,11.67 4.5,12C4.5,12.33 4.53,12.65 4.57,12.97L2.46,14.63C2.27,14.78 2.21,15.05 2.34,15.27L4.34,18.73C4.46,18.95 4.73,19.03 4.95,18.95L7.44,17.94C7.96,18.34 8.5,18.68 9.13,18.93L9.5,21.58C9.54,21.82 9.75,22 10,22H14C14.25,22 14.46,21.82 14.5,21.58L14.87,18.93C15.5,18.67 16.04,18.34 16.56,17.94L19.05,18.95C19.27,19.03 19.54,18.95 19.66,18.73L21.66,15.27C21.78,15.05 21.73,14.78 21.54,14.63L19.43,12.97Z"/></svg>,
  close: <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z"/></svg>
}

export function Gallery (props: GalleryProps) {
  const initJson = jsonForInlineScript({
    items: props.items,
    openItem: props.openItem,
    lightboxConfig: props.lightboxConfig,
    metadataConfig: props.metadataConfig,
    groupByDate: props.groupByDate,
    metaBase: props.metaBase,
    albumId: props.albumId
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
            {(props.showDownloadZip || props.canDeleteAny) && total > 0 && (
              <button id="select-start" class="btn btn-ghost" type="button">{Icon.select}<span>Select</span></button>
            )}
            {props.showDownloadZip && total > 0 && (
              <a id="download-zip" class="btn btn-ghost" href={props.path + '/download'} title="Download every photo as one ZIP file">
                {Icon.download}<span>Download all</span>
              </a>
            )}
            {props.isOwner && (
              <button id="album-settings-open" class="btn btn-ghost btn-icon-only" type="button" aria-label="Album settings" title="Album settings">{Icon.settings}</button>
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

        {(props.showDownloadZip || props.canDeleteAny) && (
          <div id="select-toolbar" hidden>
            <button id="select-cancel" class="toolbar-btn" type="button" aria-label="Stop selecting">{Icon.close}</button>
            <span id="select-count">0 selected</span>
            <button id="select-all" class="toolbar-btn-text" type="button">Select all</button>
            {props.showDownloadZip && (
              <button id="select-download" class="toolbar-btn" type="button" aria-label="Download selected" title="Download">{Icon.download}</button>
            )}
            {props.canDeleteAny && (
              <button id="select-delete" class="toolbar-btn toolbar-btn-danger" type="button" aria-label="Delete selected" title="Delete" disabled>{Icon.trash}</button>
            )}
          </div>
        )}

        {props.canDeleteAny && (
          <dialog id="delete-dialog" aria-labelledby="delete-title">
            <form method="dialog">
              <h2 id="delete-title">Delete photos?</h2>
              <ul class="delete-summary" id="delete-summary"></ul>
              <p class="form-error" id="delete-error" hidden></p>
              <div class="dialog-actions">
                <button class="btn btn-danger" type="button" id="delete-confirm">Delete</button>
                <button class="btn btn-ghost" type="button" data-close>Keep them</button>
              </div>
            </form>
          </dialog>
        )}

        {props.isOwner && props.albumId && (
          <dialog id="album-settings" aria-labelledby="album-settings-title" data-album={props.albumId}>
            <form id="rename-form" method="dialog">
              <div class="dialog-head">
                <h2 id="album-settings-title">Album settings</h2>
                <button class="icon-btn" type="button" data-close aria-label="Close">{Icon.close}</button>
              </div>
              <label class="field">
                <span>Album name</span>
                <input id="album-rename" type="text" required maxLength={120} value={albumTitle} autoComplete="off"/>
              </label>
              <p class="form-error" id="rename-error" hidden></p>
              <button class="btn btn-secondary" type="submit" id="rename-save">Save name</button>
              <fieldset class="people-section">
                <legend>People</legend>
                <ul class="people-list" id="people-list"><li class="muted">Loading…</li></ul>
                <div class="add-person" id="add-person" hidden>
                  <label class="field">
                    <span>Add someone who has an account</span>
                    <select id="people-add-user"></select>
                  </label>
                  <div class="add-person-row">
                    <select id="people-add-role" aria-label="What they can do">
                      <option value="editor">Can add photos</option>
                      <option value="viewer">View only</option>
                    </select>
                    <button class="btn btn-secondary" type="button" id="people-add">Add to album</button>
                  </div>
                </div>
                <p class="form-error" id="people-error" hidden></p>
                <p class="field-note">Someone new? Send them the invite link. They make an account in a minute.</p>
              </fieldset>
              <fieldset class="danger-zone">
                <legend>Delete this album</legend>
                <p>The album and its invite link go away for everyone. Photos stay in each person's own account.</p>
                <label class="switch"><input id="delete-album-mine" type="checkbox"/><span>Also move my photos in it to the trash</span></label>
                <p class="form-error" id="delete-album-error" hidden></p>
                <button class="btn btn-danger" type="button" id="delete-album">Delete album</button>
              </fieldset>
            </form>
          </dialog>
        )}

        <div id="toast" role="status" aria-live="polite" hidden></div>

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
          {/* Filled by uploader.ts */}
          <section id="upload-panel" hidden aria-live="polite" aria-label="Adding photos"></section>
          <div id="drop-overlay" hidden>
            <div class="drop-card">
              <Sticker tone="pink" tilt="left">Drop them!</Sticker>
              <p>Let go to add your photos to {albumTitle}</p>
            </div>
          </div>
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
