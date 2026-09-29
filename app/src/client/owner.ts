// Owner dashboard: list albums, create one, manage its share link, and add
// photos (files or a whole folder) straight into it.

import { createUploader, uploadsAvailable } from './uploader.js'

interface OwnerInit {
  name: string
  lane: 'lan' | 'internet'
  maxBytes: number
  uploads: boolean
}

interface AlbumLink {
  id: string
  url: string
  slug: string | null
  allowUpload: boolean
  allowDownload: boolean
  hasPassword: boolean
}

interface Album {
  id: string
  name: string
  count: number
  cover: string | null
  link: AlbumLink | null
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const init: OwnerInit = JSON.parse(document.getElementById('owner-init')?.textContent || '{}')

async function api<T> (method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch('/owner/api' + path, {
    method,
    headers: { 'X-Requested-With': 'photos-share', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store'
  })
  if (res.status === 401) {
    location.href = '/owner'
    throw new Error('signed out')
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || 'Something went wrong')
  return data as T
}

let albums: Album[] = []
let targetAlbum: Album | null = null

// ----- album grid ------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap> (tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

function renderAlbums () {
  const root = $('albums')
  root.replaceChildren()
  if (!albums.length) {
    const empty = el('div', 'owner-empty')
    empty.append(el('p', 'empty-title', 'No albums yet'), el('p', undefined, 'Create one, add your photos, then share the link with friends.'))
    root.append(empty)
    return
  }
  const grid = el('div', 'album-grid')
  for (const album of albums) {
    const card = el('article', 'album-card')
    const cover = el('div', 'album-cover')
    if (album.cover) {
      const img = el('img')
      img.src = album.cover
      img.alt = ''
      img.loading = 'lazy'
      cover.append(img)
    } else {
      cover.append(el('span', 'muted', 'No photos yet'))
    }
    const body = el('div', 'album-body')
    const heading = el('h2', undefined, album.name)
    const meta = el('p', 'muted', `${album.count} ${album.count === 1 ? 'item' : 'items'}` +
      (album.link ? ' · shared' + (album.link.allowUpload ? ', friends can add' : '') : ' · not shared'))
    const actions = el('div', 'album-actions')
    const add = el('button', 'btn-primary', 'Add photos')
    add.type = 'button'
    add.disabled = !init.uploads
    add.addEventListener('click', () => pick(album, false))
    const folder = el('button', 'btn-link folder-btn', 'Add a folder')
    folder.type = 'button'
    folder.disabled = !init.uploads
    folder.addEventListener('click', () => pick(album, true))
    const share = el('button', 'btn-link', album.link ? 'Share link' : 'Share')
    share.type = 'button'
    share.addEventListener('click', () => openShare(album))
    actions.append(add, folder, share)
    if (album.link) {
      const view = el('a', 'btn-link', 'Open')
      view.href = album.link.url
      view.target = '_blank'
      view.rel = 'noopener'
      actions.append(view)
    }
    body.append(heading, meta, actions)
    card.append(cover, body)
    grid.append(card)
  }
  root.append(grid)
}

async function loadAlbums () {
  try {
    albums = await api<Album[]>('GET', '/albums')
    renderAlbums()
  } catch (e) {
    $('albums').replaceChildren(el('p', 'form-error', (e as Error).message))
  }
}

// ----- new album ---------------------------------------------------------------

function setupNewAlbum () {
  const dialog = $<HTMLDialogElement>('album-dialog')
  const input = $<HTMLInputElement>('album-name')
  $('new-album').addEventListener('click', () => {
    input.value = ''
    dialog.showModal()
    input.focus()
  })
  $<HTMLFormElement>('album-form').addEventListener('submit', async (e) => {
    const name = input.value.trim()
    if (!name) {
      e.preventDefault()
      return
    }
    try {
      const { id } = await api<{ id: string }>('POST', '/albums', { name })
      await loadAlbums()
      const created = albums.find(a => a.id === id)
      // Straight into adding photos: that's almost always the next step
      if (created && init.uploads) pick(created, false)
    } catch (err) {
      alertInline((err as Error).message)
    }
  })
}

function alertInline (message: string) {
  const root = $('albums')
  const p = el('p', 'form-error', message)
  root.prepend(p)
  setTimeout(() => p.remove(), 6000)
}

// ----- share dialog --------------------------------------------------------------

let shareAlbum: Album | null = null

function openShare (album: Album) {
  shareAlbum = album
  const dialog = $<HTMLDialogElement>('owner-share-dialog')
  $('owner-share-title').textContent = 'Share "' + album.name + '"'
  $<HTMLInputElement>('share-allow-upload').checked = album.link ? album.link.allowUpload : true
  $<HTMLInputElement>('share-allow-download').checked = album.link ? album.link.allowDownload : true
  $<HTMLInputElement>('share-slug').value = album.link?.slug || ''
  $<HTMLInputElement>('owner-share-url').value = album.link?.url || ''
  $('owner-share-qr').replaceChildren()
  $('owner-share-qr').hidden = true
  $('owner-share-error').hidden = true
  $('owner-share-save').textContent = album.link ? 'Save' : 'Create link'
  $('owner-share-copy').hidden = !album.link
  dialog.showModal()
  // Existing link: fetch the QR right away (re-saving with the same settings is a no-op)
  if (album.link) saveShare(true)
}

async function saveShare (quiet = false) {
  if (!shareAlbum) return
  const errorEl = $('owner-share-error')
  errorEl.hidden = true
  try {
    const r = await api<{ url: string, qrSvg: string, slug: string | null }>('POST', `/albums/${shareAlbum.id}/share`, {
      allowUpload: $<HTMLInputElement>('share-allow-upload').checked,
      allowDownload: $<HTMLInputElement>('share-allow-download').checked,
      slug: $<HTMLInputElement>('share-slug').value.trim()
    })
    $<HTMLInputElement>('owner-share-url').value = r.url
    const qr = $('owner-share-qr')
    qr.innerHTML = r.qrSvg // server-generated SVG from the qrcode library
    qr.hidden = false
    $('owner-share-copy').hidden = false
    $('owner-share-save').textContent = 'Save'
    if (!quiet) loadAlbums()
  } catch (e) {
    errorEl.textContent = (e as Error).message
    errorEl.hidden = false
  }
}

function setupShare () {
  const dialog = $<HTMLDialogElement>('owner-share-dialog')
  $<HTMLFormElement>('owner-share-form').addEventListener('submit', (e) => {
    e.preventDefault()
    saveShare()
  })
  $('owner-share-copy').addEventListener('click', async () => {
    const input = $<HTMLInputElement>('owner-share-url')
    try {
      await navigator.clipboard.writeText(input.value)
    } catch (e) {
      input.select()
      document.execCommand('copy')
    }
    const btn = $('owner-share-copy')
    btn.textContent = 'Copied ✓'
    setTimeout(() => { btn.textContent = 'Copy link' }, 2000)
  })
  for (const d of document.querySelectorAll('dialog')) {
    d.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => (d as HTMLDialogElement).close()))
  }
  dialog.addEventListener('close', () => { shareAlbum = null })
}

// ----- uploads -------------------------------------------------------------------

let uploader: ReturnType<typeof createUploader> | null = null

function pick (album: Album, folder: boolean) {
  targetAlbum = album
  $(folder ? 'folder-input' : 'upload-input').click()
}

function setupUploads () {
  if (!init.uploads || !uploadsAvailable()) return
  uploader = createUploader({
    maxBytes: init.maxBytes,
    doneTitle: (done, failed) => failed
      ? `${done} added · ${failed} didn't make it`
      : `✅ ${done} ${done === 1 ? 'item' : 'items'} added`,
    onAllDone: () => { loadAlbums() }
  })
  $('upload-lane').textContent = init.lane === 'lan' ? '⚡ direct on home Wi-Fi' : 'via the internet'
  $('upload-view').addEventListener('click', () => { $('upload-panel').hidden = true })

  for (const id of ['upload-input', 'folder-input']) {
    const input = $<HTMLInputElement>(id)
    input.addEventListener('change', () => {
      // Folder picks include everything; keep photos and videos only
      const files = Array.from(input.files || []).filter(f =>
        /^(image|video)\//.test(f.type) ||
        /\.(heic|heif|dng|cr2|cr3|nef|arw|raf|orf|rw2|mov|mp4|m4v|3gp|mts)$/i.test(f.name))
      input.value = ''
      if (!files.length || !targetAlbum || !uploader) return
      $('upload-album').textContent = targetAlbum.name
      uploader.add(files, { mode: 'owner', albumId: targetAlbum.id })
    })
  }
}

setupNewAlbum()
setupShare()
setupUploads()
loadAlbums()
