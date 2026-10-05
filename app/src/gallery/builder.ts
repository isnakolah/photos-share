import {
  getVideoContentType,
  photoUrl,
  videoUrl
} from '../immich'
import { Response } from 'express-serve-static-core'
import { Asset, AssetType, ImageSize, SharedLink } from '../types'
import { getConfigOption } from '../config/access'
import { canDownload, expiryDate, title } from '../share'
import { toString } from '../utils/text'
import { h } from 'preact'
import { renderPage } from '../view/render'
import { Gallery, GalleryItem, GalleryProps } from '../view/gallery'
import type { GroupByDateMode } from '../shared/types'
import { downloadFilename } from './filename'
import { requiresOriginal } from './sizing'
import { displayDimensions, metadataGroupActive, pickExif } from './exif'
import QRCode from 'qrcode'
import { uploadersForAlbum, momentoDraftFor } from '../attribution/db'
import { maxUploadBytes, uploadsEnabled } from '../upload/server'
import { momentoConfigured } from '../momento/client'
import { albumOwner, albumPeople } from '../account/access'
import type { AlbumInfo, AlbumRole } from '../account/access'

/**
 * Render a gallery page for a given SharedLink.
 *
 * @param res - ExpressJS Response
 * @param share - Immich `shared-link` containing the assets to show in the gallery
 * @param [openItem] - Immediately open the lightbox to the Nth item when the gallery loads
 */
export async function gallery (res: Response, share: SharedLink, openItem?: number) {
  // publicBaseUrl is used for the og:image, which requires a fully qualified URL.
  // You can specify this in your docker-compose file via the PUBLIC_BASE_URL env var.
  const publicBaseUrl = process.env.PUBLIC_BASE_URL || (res.req.protocol + '://' + res.req.headers.host)

  // Date grouping needs chronological order; follow the album's own sort
  // direction, defaulting to newest-first when it has none (individual shares).
  // Sort by the same local timestamp the grouping buckets on, so buckets stay
  // contiguous / ordered.
  const groupByDate = groupByDateMode()
  if (groupByDate) {
    share.assets.sort(dateSortComparator(share.album?.order))
  }

  // Metadata display flags. Read once here and forwarded to the client via
  // `metadataConfig` in the init JSON.
  // The share owner's "Show metadata" toggle in Immich is a kill-switch over
  // the operator's own config: when explicitly `false`, no EXIF / location /
  // description fields are surfaced, regardless of `ipp.showMetadata.*`
  const shareMetadataAllowed = share.showMetadata !== false
  // Offer a zoom upgrade only when the operator opted in AND Immich would serve
  // it: web `fullsize` resolves to `/original`, which Immich refuses unless the
  // share's own download toggle (`share.allowDownload`) is on. Deliberately
  // independent of IPP's `allowDownload` config.
  const zoomUpgrade = getConfigOption('ipp.maxZoomQuality', 'preview') === 'fullsize' && share.allowDownload !== false
  const motionPhotos = !!getConfigOption('ipp.motionPhotos', true)
  const descriptionInCaption = shareMetadataAllowed && !!getConfigOption('ipp.showMetadata.description.caption', false)
  const descriptionInSidebar = shareMetadataAllowed && !!getConfigOption('ipp.showMetadata.description.sidebar', false)
  const sidebarHasContent = shareMetadataAllowed && (descriptionInSidebar || metadataGroupActive('exif') || metadataGroupActive('location'))

  // Who added what. Immich records each asset's owner; map that to the album's
  // people. The upload log covers anything the timeline didn't attribute.
  const album = res.locals?.album as AlbumInfo | undefined
  const role = res.locals?.role as AlbumRole | undefined
  const account = res.req.account
  const people = new Map<string, string>()
  for (const u of albumPeople(album)) people.set(u.id, u.name)
  const ownerName = albumOwner(album)?.name
  let uploaderMap = new Map<string, string>()
  try {
    if (share.album?.id) uploaderMap = uploadersForAlbum(share.album.id)
  } catch (e) {
    // Attribution is best-effort; never let it break the gallery.
  }
  const uploadedBy = (asset: Asset) =>
    (asset.ownerId && people.get(asset.ownerId)) || uploaderMap.get(asset.id) || ownerName || undefined
  const uploaderCounts = new Map<string, number>()
  for (const asset of share.assets) {
    const name = uploadedBy(asset)
    if (name) uploaderCounts.set(name, (uploaderCounts.get(name) || 0) + 1)
  }
  const requestedBy = typeof res.req.query?.by === 'string' ? res.req.query.by : ''
  const activeUploader = requestedBy && uploaderCounts.has(requestedBy) ? requestedBy : ''
  // Never mutate share.assets in place here: it's the cached shared object.
  const assets = activeUploader ? share.assets.filter(a => uploadedBy(a) === activeUploader) : share.assets

  const items: GalleryItem[] = await Promise.all(assets.map(async (asset): Promise<GalleryItem> => {
    let videoData: string | undefined
    if (asset.type === AssetType.video) {
      const source: { src: string, type?: string } = { src: videoUrl(share.key, asset.id) }
      // Album "grid" videos defer the content-type probe (one upstream call
      // per video) - a <source> with no type lets the browser fall back to
      // the proxy's response Content-Type, keeping grid render O(buckets).
      if (!asset.needsDetail) source.type = await getVideoContentType(asset)
      videoData = JSON.stringify({
        source: [source],
        attributes: {
          playsinline: 'playsinline',
          controls: 'controls'
        }
      })
    }

    const downloadUrl = photoUrl(share.key, asset.id, ImageSize.original)
    const thumbnailUrl = photoUrl(share.key, asset.id, ImageSize.thumbnail)
    // Always request `preview`; the resolver floors gif/video up to the
    // original on its own (their preview is a static frame).
    const previewUrl = photoUrl(share.key, asset.id, ImageSize.preview)
    // Still images only - gif/video are already served at their highest tier.
    const fullUrl = zoomUpgrade && asset.type === AssetType.image && !requiresOriginal(asset)
      ? photoUrl(share.key, asset.id, ImageSize.fullsize)
      : undefined
    // Motion photo clip, served through the video route under the same key.
    const motionUrl = motionPhotos && asset.type === AssetType.image && asset.livePhotoVideoId
      ? videoUrl(share.key, asset.livePhotoVideoId)
      : undefined
    // Plain text; the client uses textContent so no escaping needed here.
    // Description is included if EITHER surface (caption or sidebar) wants it.
    const descriptionEnabled = descriptionInCaption || descriptionInSidebar
    const itemDescription = descriptionEnabled && typeof asset?.exifInfo?.description === 'string'
      ? asset.exifInfo.description
      : ''

    const { width, height } = displayDimensions(asset)

    return {
      id: asset.id,
      uploadedBy: uploadedBy(asset),
      // Your own photos: trash. Admins (and the album owner) can take anyone
      // else's out of the album. Everyone else: only what they added.
      deleteKind: account && asset.ownerId === account.userId
        ? 'trash'
        : account?.isAdmin || role === 'owner' ? 'remove' : undefined,
      type: asset.type,
      previewUrl,
      fullUrl,
      thumbnailUrl,
      downloadUrl,
      videoData,
      motionUrl,
      description: itemDescription || undefined,
      downloadFilename: downloadFilename(asset),
      width,
      height,
      thumbhash: asset.thumbhash,
      fileCreatedAt: asset.fileCreatedAt,
      localDateTime: asset.localDateTime,
      exif: shareMetadataAllowed ? pickExif(asset) : undefined,
      // Album grid items carry no exif / description / real filename yet; the
      // client fetches them from `metaBase` the first time the item opens.
      needsDetail: asset.needsDetail || undefined
    }
  }))

  // Album shares contain lazy items; expose the on-demand metadata route so
  // the client can fetch per-asset detail on lightbox open. Individual shares
  // bake everything in, so no metaBase is needed there.
  const metaBase = items.some(item => item.needsDetail) ? '/share/meta/' + share.key : undefined

  const downloadAllowed = canDownload(share)
  // Prefer the album's owner-chosen cover for og:image; fall back to first
  // item if the cover asset has been filtered out (e.g. trashed).
  const coverId = share.album?.albumThumbnailAssetId
  const ogImageItem = (coverId && items.find(i => i.id === coverId)) || items[0]
  // Guard against an operator setting ipp.lightbox.options to a non-object;
  // a string would otherwise spread character-by-character into PhotoSwipe.
  const rawLightboxOptions = getConfigOption('ipp.lightbox.options', {})
  const lightboxOptions: Record<string, unknown> = (rawLightboxOptions && typeof rawLightboxOptions === 'object' && !Array.isArray(rawLightboxOptions))
    ? rawLightboxOptions as Record<string, unknown>
    : {}
  const canAdd = role === 'owner' || role === 'editor'
  const uploadEnabled = uploadsEnabled() && canAdd
  const linkPath = share.slug ? '/s/' + encodeURIComponent(share.slug) : '/share/' + share.key
  const shareUrl = toString(publicBaseUrl).replace(/\/+$/, '') + linkPath
  const qrSvg = await QRCode.toString(shareUrl, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' })
  const props: GalleryProps = {
    items,
    upload: uploadEnabled && album
      ? {
          albumId: album.id,
          maxBytes: maxUploadBytes(),
          // Display only: the LAN gateway marks requests it forwards
          lane: res.req.headers['x-photos-lane'] === 'lan' && !res.req.headers['cf-ray'] ? 'lan' : 'internet'
        }
      : undefined,
    invite: {
      url: shareUrl,
      qrSvg,
      canManage: role === 'owner',
      albumId: album?.id || '',
      slug: share.slug || '',
      allowUpload: !!share.allowUpload,
      allowDownload: share.allowDownload !== false
    },
    account,
    ownerName: ownerName || '',
    members: [...people.values()],
    totalCount: share.assets.length,
    uploaders: [...uploaderCounts.entries()].map(([name, count]) => ({ name, count })),
    activeUploader,
    pagePath: res.req.path || linkPath,
    title: title(share),
    description: getConfigOption('ipp.gallery.showDescription', false) ? description(share) : '',
    publicBaseUrl: toString(publicBaseUrl),
    path: '/share/' + share.key,
    showDownloadZip: downloadAllowed && !!getConfigOption('ipp.gallery.showDownloadZip', true),
    showTitle: !!getConfigOption('ipp.gallery.showTitle', true),
    expiryDate: expiryDate(share),
    openItem,
    ogImageItem,
    lightboxConfig: {
      // Show download button only if downloading is allowed AND configured.
      showDownload: downloadAllowed && !!getConfigOption('ipp.lightbox.showDownload', true),
      showArrows: !!getConfigOption('ipp.lightbox.showArrows', true),
      mobileArrows: !!getConfigOption('ipp.lightbox.mobileArrows', false),
      autoPlayVideos: !!getConfigOption('ipp.lightbox.autoPlayVideos', false),
      options: lightboxOptions
    },
    metadataConfig: {
      descriptionInCaption,
      descriptionInSidebar,
      sidebarHasContent,
      locationWebLink: !!getConfigOption('ipp.showMetadata.location.webLink', true)
    },
    groupByDate,
    metaBase,
    albumId: album?.id,
    canDeleteAny: items.some(i => i.deleteKind),
    momento: account?.isAdmin && momentoConfigured() && album
      ? { hasDraft: !!momentoDraftFor(album.id) }
      : undefined,
    isOwner: role === 'owner'
  }

  // Pages are per-person now (who's viewing, what they may do): never share
  // them through a cache, and always revalidate.
  res.header('Cache-Control', 'private, no-cache')
  res.send(renderPage(h(Gallery, props)))
}

/**
 * Get the Immich shared link description (album-level, not per-asset).
 */
function description (share: SharedLink) {
  return share?.album?.description || ''
}

/**
 * Comparator for the date-grouping sort: ascending when the album's order is
 * `'asc'`, otherwise newest-first (individual shares and orderless albums).
 * Undated assets always sort last regardless of direction, so the client's
 * "Undated" group renders at the bottom.
 */
export function dateSortComparator (order?: string): (a: Asset, b: Asset) => number {
  const ascending = order === 'asc'
  const sortKey = (a: Asset) => a.localDateTime || a.fileCreatedAt || ''
  return (a, b) => {
    const ka = sortKey(a)
    const kb = sortKey(b)
    if (!ka || !kb) return ka ? -1 : kb ? 1 : 0 // undated always last
    return ascending ? ka.localeCompare(kb) : kb.localeCompare(ka)
  }
}

/**
 * Normalise the operator's `ipp.gallery.groupByDate` config into a grouping
 * mode. Accepts `false` (off), `true` / `'month'` (legacy = month buckets) or
 * `'day'` (day buckets); anything else is treated as off.
 */
function groupByDateMode (): GroupByDateMode | false {
  const v = getConfigOption('ipp.gallery.groupByDate', false)
  if (v === 'day') return 'day'
  if (v === true || v === 'month') return 'month'
  return false
}
