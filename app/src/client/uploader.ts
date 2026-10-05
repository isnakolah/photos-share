// Upload queue + the upload sheet UI (progress ring, thumbnail grid,
// minimise, ETA, retry). tus does the transfer in 50 MB chunks so uploads get
// past Cloudflare's 100 MB request cap and survive flaky connections.

// tus-js-client's browser bundle (served from /share/static/vendor) sets `window.tus`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const tus: any

const CHUNK_SIZE = 50 * 1024 * 1024
const PARALLEL = 3
const PREVIEW_PARALLEL = 2

type ItemState = 'queued' | 'uploading' | 'saving' | 'done' | 'duplicate' | 'error'

interface Item {
  file: File
  tile: HTMLElement
  state: ItemState
  loaded: number
  metadata: Record<string, string>
  uploadId?: string
  error?: string
  preview?: string
}

export interface UploaderOptions {
  maxBytes: number
  albumName: string
  lane?: 'lan' | 'internet'
}

export function uploadsAvailable (): boolean {
  return typeof tus !== 'undefined'
}

const RAW = /\.(heic|heif|dng|cr2|cr3|nef|arw|raf|orf|rw2)$/i
const VIDEO = /\.(mov|mp4|m4v|3gp|mts|avi|mkv|webm)$/i

function el<K extends keyof HTMLElementTagNameMap> (tag: K, cls?: string, text?: string) {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

function formatEta (seconds: number): string {
  if (!isFinite(seconds) || seconds <= 0) return ''
  if (seconds < 50) return 'a few seconds left'
  if (seconds < 90) return 'about a minute left'
  if (seconds < 3600) return `about ${Math.round(seconds / 60)} min left`
  return `about ${Math.round(seconds / 3600 * 10) / 10} h left`
}

export function createUploader (opts: UploaderOptions) {
  const panel = document.getElementById('upload-panel') as HTMLElement
  const items: Item[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let wakeLock: any = null

  // ----- build the sheet ------------------------------------------------------
  panel.replaceChildren()
  const head = el('div', 'up-head')
  const ring = el('div', 'up-ring')
  ring.innerHTML = '<svg viewBox="0 0 44 44" aria-hidden="true"><circle class="up-ring-track" cx="22" cy="22" r="19"/><circle class="up-ring-fill" cx="22" cy="22" r="19"/></svg>'
  const pct = el('span', 'up-pct', '0%')
  ring.append(pct)
  const headText = el('div', 'up-head-text')
  const title = el('strong', 'up-title', 'Getting ready…')
  const sub = el('span', 'up-sub', 'to ' + opts.albumName)
  headText.append(title, sub)
  const minBtn = el('button', 'icon-btn up-min')
  minBtn.type = 'button'
  minBtn.setAttribute('aria-label', 'Minimise')
  minBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M7.41,8.58L12,13.17L16.59,8.58L18,10L12,16L6,10L7.41,8.58Z"/></svg>'
  head.append(ring, headText, minBtn)

  const lane = el('p', 'up-lane ' + (opts.lane === 'lan' ? 'is-lan' : ''),
    opts.lane === 'lan' ? 'Straight to your NAS over home Wi-Fi' : 'Over the internet')
  const hint = el('p', 'up-hint', 'Keep this page open until it\'s done. You can keep browsing.')
  const grid = el('div', 'up-grid')
  const actions = el('div', 'up-actions')
  const retryBtn = el('button', 'btn btn-ghost', 'Retry failed')
  retryBtn.type = 'button'
  const moreBtn = el('button', 'btn btn-ghost', 'Add more')
  moreBtn.type = 'button'
  const doneBtn = el('button', 'btn btn-primary', 'See them in the album')
  doneBtn.type = 'button'
  actions.append(retryBtn, moreBtn, doneBtn)
  panel.append(head, lane, hint, grid, actions)

  const ringFill = ring.querySelector('.up-ring-fill') as SVGCircleElement
  const CIRC = 2 * Math.PI * 19
  ringFill.style.strokeDasharray = String(CIRC)

  minBtn.addEventListener('click', () => panel.classList.toggle('is-min'))
  head.addEventListener('click', (e) => {
    // Tapping the minimised pill expands it (the arrow button handles itself)
    if (panel.classList.contains('is-min') && !minBtn.contains(e.target as Node)) panel.classList.remove('is-min')
  })
  retryBtn.addEventListener('click', () => {
    for (const it of items) if (it.state === 'error' && it.error !== 'Too large') { it.loaded = 0; setState(it, 'queued') }
    pump()
  })
  doneBtn.addEventListener('click', () => location.reload())

  // ----- speed / ETA ---------------------------------------------------------
  let lastBytes = 0
  let lastTime = performance.now()
  let speed = 0 // bytes per second, smoothed

  function sample (bytesDone: number) {
    const now = performance.now()
    const dt = (now - lastTime) / 1000
    if (dt >= 1) {
      const inst = Math.max(0, bytesDone - lastBytes) / dt
      speed = speed ? speed * 0.7 + inst * 0.3 : inst
      lastBytes = bytesDone
      lastTime = now
    }
  }

  // ----- items ------------------------------------------------------------------
  function add (files: File[], metadata: Record<string, string>) {
    for (const file of files) {
      const tile = el('div', 'up-tile')
      const label = file.name.split('.').pop()?.toUpperCase() || 'FILE'
      const ph = el('span', 'up-tile-ph', VIDEO.test(file.name) || file.type.startsWith('video/') ? '▶' : label)
      tile.append(ph, el('span', 'up-tile-bar'), el('span', 'up-tile-badge'))
      tile.title = file.webkitRelativePath || file.name
      grid.append(tile)
      const item: Item = { file, tile, state: 'queued', loaded: 0, metadata }
      items.push(item)
      if (file.size > opts.maxBytes) {
        item.error = 'Too large'
        setState(item, 'error')
      } else {
        setState(item, 'queued')
      }
      tile.addEventListener('click', () => {
        if (item.state === 'error' && item.error !== 'Too large') {
          item.loaded = 0
          setState(item, 'queued')
          pump()
        }
      })
    }
    panel.hidden = false
    panel.classList.remove('is-done', 'is-min')
    requestWakeLock()
    pump()
    makePreviews()
  }

  function setState (item: Item, state: ItemState) {
    item.state = state
    item.tile.dataset.state = state
    const frac = item.file.size ? item.loaded / item.file.size : 0
    item.tile.style.setProperty('--p', String(state === 'uploading' ? frac : (state === 'queued' || state === 'error') ? 0 : 1))
    item.tile.setAttribute('aria-label', `${item.file.name}: ${({
      queued: 'waiting',
      uploading: Math.floor(frac * 100) + '%',
      saving: 'saving',
      done: 'added',
      duplicate: 'already in the album',
      error: item.error || 'failed, tap to retry'
    } as Record<ItemState, string>)[state]}`)
    render()
  }

  // Small previews, made off the main file so hundreds of photos stay light
  let previewing = 0
  function makePreviews () {
    while (previewing < PREVIEW_PARALLEL) {
      const next = items.find(it => it.preview === undefined && it.file.type.startsWith('image/') && !RAW.test(it.file.name))
      if (!next) return
      next.preview = ''
      previewing++
      createImageBitmap(next.file, { resizeWidth: 180, resizeQuality: 'medium' })
        .then(bmp => {
          const canvas = document.createElement('canvas')
          canvas.width = bmp.width
          canvas.height = bmp.height
          canvas.getContext('2d')?.drawImage(bmp, 0, 0)
          bmp.close()
          return new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.7))
        })
        .then(blob => {
          if (!blob) return
          next.preview = URL.createObjectURL(blob)
          const img = el('img')
          img.alt = ''
          img.src = next.preview
          next.tile.prepend(img)
          next.tile.classList.add('has-img')
        })
        .catch(() => { /* unsupported format: keep the label tile */ })
        .finally(() => { previewing--; makePreviews() })
    }
  }

  function pump () {
    let active = items.filter(i => i.state === 'uploading').length
    for (const item of items) {
      if (active >= PARALLEL) break
      if (item.state !== 'queued') continue
      start(item)
      active++
    }
    render()
  }

  function start (item: Item) {
    setState(item, 'uploading')
    const upload = new tus.Upload(item.file, {
      endpoint: '/share/upload',
      chunkSize: CHUNK_SIZE,
      retryDelays: [0, 1000, 3000, 5000, 10000, 20000, 30000, 60000],
      removeFingerprintOnSuccess: true,
      metadata: {
        ...item.metadata,
        filename: item.file.name,
        filetype: item.file.type,
        lastModified: String(item.file.lastModified || '')
      },
      onProgress: (loaded: number) => {
        item.loaded = loaded
        setState(item, 'uploading')
      },
      onSuccess: () => {
        item.loaded = item.file.size
        item.uploadId = String(upload.url || '').split('/').pop()
        setState(item, 'saving')
        pump()
        pollStatus()
      },
      onError: (err: Error & { originalResponse?: { getBody (): string } }) => {
        const body = err.originalResponse?.getBody?.() || ''
        item.error = body && body.length < 90 ? body : 'Couldn\'t upload. Tap to retry.'
        setState(item, 'error')
        pump()
      }
    })
    // Resume a transfer interrupted earlier (reload, dropped connection)
    upload.findPreviousUploads().then((previous: unknown[]) => {
      if (previous.length) upload.resumeFromPreviousUpload(previous[0])
      upload.start()
    })
  }

  let polling = false
  async function pollStatus () {
    if (polling) return
    polling = true
    try {
      while (items.some(i => i.state === 'saving')) {
        await new Promise(resolve => setTimeout(resolve, 1500))
        const waiting = items.filter(i => i.state === 'saving' && i.uploadId)
        if (!waiting.length) continue
        try {
          const res = await fetch('/share/upload/status?ids=' + waiting.map(i => i.uploadId).join(','), { cache: 'no-store' })
          const statuses: Array<{ id: string, status: string, duplicate?: boolean }> = await res.json()
          for (const s of statuses) {
            const item = waiting.find(i => i.uploadId === s.id)
            if (!item) continue
            if (s.status === 'done') setState(item, s.duplicate ? 'duplicate' : 'done')
            else if (s.status === 'error') { item.error = 'Couldn\'t save. Tap to retry.'; setState(item, 'error') }
          }
        } catch (e) { /* try again next tick */ }
      }
    } finally {
      polling = false
    }
  }

  function busy () {
    return items.some(i => i.state === 'queued' || i.state === 'uploading' || i.state === 'saving')
  }

  let renderQueued = false
  function render () {
    if (renderQueued) return
    renderQueued = true
    requestAnimationFrame(() => {
      renderQueued = false
      const total = items.length
      if (!total) return
      const added = items.filter(i => i.state === 'done').length
      const dupes = items.filter(i => i.state === 'duplicate').length
      const failed = items.filter(i => i.state === 'error').length
      const finished = added + dupes
      const isBusy = busy()
      const bytesTotal = items.reduce((n, i) => n + (i.state === 'error' ? 0 : i.file.size), 0) || 1
      const bytesDone = items.reduce((n, i) => n + (['done', 'duplicate', 'saving'].includes(i.state) ? i.file.size : i.state === 'error' ? 0 : i.loaded), 0)
      const frac = Math.min(1, bytesDone / bytesTotal)
      sample(bytesDone)
      ringFill.style.strokeDashoffset = String(CIRC * (1 - frac))
      pct.textContent = Math.floor(frac * 100) + '%'

      if (isBusy) {
        const sent = items.filter(i => i.state === 'saving' || i.state === 'done' || i.state === 'duplicate').length
        title.textContent = `Sending ${Math.min(sent + 1, total)} of ${total}`
        const eta = speed > 0 ? formatEta((bytesTotal - bytesDone) / speed) : ''
        sub.textContent = 'to ' + opts.albumName + (eta ? ' · ' + eta : '')
        panel.classList.remove('is-done')
      } else {
        const noun = (n: number) => n === 1 ? 'photo' : 'photos'
        title.textContent = failed
          ? `${finished} added, ${failed} didn't make it`
          : `${added} ${noun(added)} added!`
        sub.textContent = dupes
          ? `${dupes} ${dupes === 1 ? 'was' : 'were'} already in ${opts.albumName}`
          : (failed ? 'Tap a red tile, or retry them all.' : `They're in ${opts.albumName} now.`)
        pct.textContent = failed ? '!' : '✓'
        panel.classList.toggle('is-done', !failed)
        panel.classList.remove('is-min')
        releaseWakeLock()
      }
      hint.hidden = !isBusy
      retryBtn.hidden = isBusy || !items.some(i => i.state === 'error' && i.error !== 'Too large')
      moreBtn.hidden = isBusy
      doneBtn.hidden = isBusy || finished === 0
    })
  }

  async function requestWakeLock () {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const nav = navigator as any
      if (!wakeLock && nav.wakeLock) wakeLock = await nav.wakeLock.request('screen')
    } catch (e) { }
  }

  function releaseWakeLock () {
    wakeLock?.release?.()
    wakeLock = null
  }

  window.addEventListener('beforeunload', (e) => {
    if (items.some(i => i.state === 'queued' || i.state === 'uploading')) {
      e.preventDefault()
      e.returnValue = ''
    }
  })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && busy()) requestWakeLock()
  })

  return { add, busy, onAddMore: (fn: () => void) => moreBtn.addEventListener('click', fn) }
}
