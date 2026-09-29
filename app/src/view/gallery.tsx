import { AssetType } from '../types'
import { ThemeScript } from './theme'
import { GalleryItem, LightboxConfig, MetadataConfig, GroupByDateMode } from '../shared/types'
import { ASSET_VERSION } from '../version'
import { jsonForInlineScript } from '../utils/text'

export type { GalleryItem, LightboxConfig, MetadataConfig, GroupByDateMode }

export interface GalleryProps {
  items: GalleryItem[]
  title: string
  description: string
  publicBaseUrl: string
  path: string
  showDownloadZip: boolean
  showTitle: boolean
  // Formatted "available until" date shown in the subtitle, or undefined when
  // ipp.gallery.showExpiryDate is off or the share never expires.
  expiryDate?: string
  openItem?: number
  ogImageItem?: GalleryItem
  lightboxConfig: LightboxConfig
  metadataConfig: MetadataConfig
  groupByDate: GroupByDateMode | false
  metaBase?: string
  // Guest upload config; undefined when this link doesn't accept uploads
  upload?: { shareKey: string, maxBytes: number }
  // Canonical link to this share and its QR code (inline SVG)
  share?: { url: string, qrSvg: string }
  // Everyone who has added to this album, for the "added by" filter
  uploaders?: Array<{ name: string, count: number }>
  activeUploader?: string
  pagePath?: string
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
  const firstItem = props.items[0]
  // og:image prefers the album cover (passed via props); for videos, previewUrl
  // points to the .mp4, so use thumbnailUrl to keep og:image a still JPEG.
  const ogItem = props.ogImageItem || firstItem
  const ogImageAsset = ogItem
    ? (ogItem.type === AssetType.video ? ogItem.thumbnailUrl : ogItem.previewUrl)
    : ''
  const ogImageUrl = ogItem ? props.publicBaseUrl + ogImageAsset : ''
  // The title block also carries the subtitle (item count + optional expiry),
  // so it renders when a title is wanted OR there's an expiry date to show.
  const showHeaderText = props.showTitle || !!props.expiryDate

  return (
    <html lang="en">
      <head>
        <ThemeScript/>
        <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
        <title>{props.title}</title>
        <meta property="og:title" content={props.title}/>
        <meta name="twitter:title" content={props.title}/>
        {props.description && <>
          <meta name="description" content={props.description}/>
          <meta property="og:description" content={props.description}/>
          <meta property="twitter:description" content={props.description}/>
        </>}
        {firstItem && <>
          <meta property="og:image" content={ogImageUrl}/>
          <meta name="twitter:image" content={ogImageUrl}/>
          <meta name="twitter:card" content="summary_large_image"/>
        </>}
        <link rel="icon" href="/share/static/favicon.ico" type="image/x-icon"/>
        <link type="text/css" rel="stylesheet" href={`/share/static/${ASSET_VERSION}/style.css`}/>
        <link type="text/css" rel="stylesheet" href="/share/static/photoswipe/photoswipe.css"/>
        <link type="text/css" rel="stylesheet" href={`/share/static/${ASSET_VERSION}/photoswipe-overrides.css`}/>
      </head>
      <body>
        {(showHeaderText || props.showDownloadZip || props.upload || props.share) && (
          <header id="header">
            {showHeaderText && (
              <div class="header-text">
                {props.showTitle && <h1>{props.title || 'Gallery'}</h1>}
                <p class="subtitle">
                  {props.items.length}{' '}
                  {props.items.length === 1 ? 'item' : 'items'}
                  {props.expiryDate && (
                    <>{' · available until '}{props.expiryDate}</>
                  )}
                </p>
              </div>
            )}
            <div class="header-actions">
              {props.upload && (
                <button id="add-photos" class="btn-primary" type="button">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4,4H7L9,2H15L17,4H20A2,2 0 0,1 22,6V18A2,2 0 0,1 20,20H4A2,2 0 0,1 2,18V6A2,2 0 0,1 4,4M12,7A5,5 0 0,0 7,12A5,5 0 0,0 12,17A5,5 0 0,0 17,12A5,5 0 0,0 12,7M12,9A3,3 0 0,1 15,12A3,3 0 0,1 12,15A3,3 0 0,1 9,12A3,3 0 0,1 12,9Z"/></svg>
                  <span>Add your photos</span>
                </button>
              )}
              {props.share && (
                <button id="share-open" class="icon-btn" type="button" title="Share this album" aria-label="Share this album">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M3,11H5V13H3V11M11,5H13V9H11V5M9,11H13V15H11V13H9V11M15,11H17V13H19V11H21V13H19V15H21V19H19V21H17V19H13V21H11V17H15V15H17V13H15V11M19,19V15H17V19H19M15,3H21V9H15V3M17,5V7H19V5H17M3,3H9V9H3V3M5,5V7H7V5H5M3,15H9V21H3V15M5,17V19H7V17H5Z"/></svg>
                </button>
              )}
              {props.showDownloadZip && (
                <a id="download-all" class="icon-btn" href={props.path + '/download'} title="Download all" aria-label="Download all">
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path fill="currentColor" d="M5,20H19V18H5M19,9H15V3H9V9H5L12,16L19,9Z"/>
                  </svg>
                </a>
              )}
            </div>
          </header>
        )}
        {props.uploaders && props.uploaders.length > 1 && (
          <nav id="uploader-filter" aria-label="Filter by who added">
            <a href={props.pagePath || props.path} class={props.activeUploader ? '' : 'active'}>Everyone</a>
            {props.uploaders.map(u => (
              <a
                href={(props.pagePath || props.path) + '?by=' + encodeURIComponent(u.name)}
                class={props.activeUploader === u.name ? 'active' : ''}
              >{u.name} <span class="count">{u.count}</span></a>
            ))}
          </nav>
        )}
        {props.upload && props.items.length === 0 && !props.activeUploader && (
          <section id="empty-album">
            <p class="empty-title">No photos here yet</p>
            <p>Be the first. Tap <strong>Add your photos</strong> and pick some from your phone.</p>
          </section>
        )}
        {props.description && (
          <p id="album-description">{props.description}</p>
        )}
{/* Container is intentionally empty - web.js's virtualisation manager
            populates it with only the tiles within the viewport buffer. */}
        <div id="gallery"></div>
        {props.showDownloadZip && (
          <div id="select-toolbar" hidden>
            <button id="select-cancel" class="toolbar-btn" type="button" aria-label="Exit selection mode">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path fill="currentColor" d="M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z"/>
              </svg>
            </button>
            <span id="select-count">0 selected</span>
            <button id="select-all" class="toolbar-btn-text" type="button">Select all</button>
            <button id="select-download" class="toolbar-btn" type="button" aria-label="Download selected">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path fill="currentColor" d="M5,20H19V18H5M19,9H15V3H9V9H5L12,16L19,9Z"/>
              </svg>
            </button>
          </div>
        )}
        {/* Init params for web.js (read at module load). Using a JSON script
            block avoids the cross-script-type coordination problems that come
            with mixing classic and module scripts. */}
        <script
          type="application/json"
          id="ipp-init"
          dangerouslySetInnerHTML={{ __html: initJson }}
        />
        <script type="module" src={`/share/static/${ASSET_VERSION}/js/client/init.js`}></script>
        {props.share && (
          <dialog id="share-dialog" aria-labelledby="share-title">
            <h2 id="share-title">Share this album</h2>
            <p>Friends can scan this, or you can send them the link.</p>
            <div class="qr" dangerouslySetInnerHTML={{ __html: props.share.qrSvg }}/>
            <input id="share-url" type="text" readOnly value={props.share.url} aria-label="Album link"/>
            <div class="dialog-actions">
              <button id="share-copy" class="btn-primary" type="button">Copy link</button>
              <button id="share-close" class="btn-link" type="button">Close</button>
            </div>
          </dialog>
        )}
        {props.upload && <>
          <input type="file" id="upload-input" accept="image/*,video/*" multiple hidden/>
          <dialog id="name-dialog" aria-labelledby="name-title">
            <form id="name-form" method="dialog">
              <h2 id="name-title">Who's adding photos?</h2>
              <p>Your name will show next to the photos you add.</p>
              <input id="uploader-name" name="name" type="text" required maxLength={40} autoComplete="given-name" autoCapitalize="words" enterKeyHint="go" placeholder="Your name"/>
              <div class="dialog-actions">
                <button class="btn-primary" type="submit">Choose photos</button>
                <button id="name-cancel" class="btn-link" type="button">Cancel</button>
              </div>
            </form>
          </dialog>
          <section id="upload-panel" hidden aria-live="polite">
            <div class="upload-head">
              <strong id="upload-title">Adding your photos…</strong>
              <span class="upload-who">as <span id="upload-name"></span> · <button id="change-name" class="btn-link" type="button">not you?</button></span>
            </div>
            <div class="upload-bar"><div id="upload-bar-fill"></div></div>
            <p id="upload-hint">Keep this page open until it's finished.</p>
            <ul id="upload-list"></ul>
            <div class="dialog-actions">
              <button id="upload-view" class="btn-primary" type="button" hidden>See them in the album</button>
              <button id="upload-more" class="btn-link" type="button" hidden>Add more</button>
            </div>
          </section>
          <script
            type="application/json"
            id="ipp-upload"
            dangerouslySetInnerHTML={{ __html: jsonForInlineScript(props.upload) }}
          />
          <script src="/share/static/vendor/tus.min.js"></script>
        </>}
        <script type="module" src={`/share/static/${ASSET_VERSION}/js/client/extras.js`}></script>
      </body>
    </html>
  )
}
