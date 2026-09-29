// Shared tus upload queue + progress panel, used by the guest share page
// (extras.ts) and the owner dashboard (owner.ts).

// tus-js-client's browser bundle (served from /share/static/vendor) sets `window.tus`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const tus: any

const CHUNK_SIZE = 50 * 1024 * 1024 // stays under Cloudflare's 100 MB request cap
const PARALLEL = 3

type ItemState = 'queued' | 'uploading' | 'saving' | 'done' | 'error'

interface Item {
  file: File
  el: HTMLLIElement
  state: ItemState
  loaded: number
  metadata: Record<string, string>
  uploadId?: string
}

export interface UploaderOptions {
  maxBytes: number
  // Title once everything finished, e.g. "✅ 12 photos added. Thanks, Amina!"
  doneTitle: (done: number, failed: number) => string
  onAllDone?: () => void
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null

export function uploadsAvailable (): boolean {
  return typeof tus !== 'undefined'
}

export function createUploader (opts: UploaderOptions) {
  const panel = $<HTMLElement>('upload-panel')
  const list = $<HTMLUListElement>('upload-list')
  const title = $<HTMLElement>('upload-title')
  const hint = $<HTMLElement>('upload-hint')
  const barFill = $<HTMLElement>('upload-bar-fill')
  const viewBtn = $<HTMLButtonElement>('upload-view')
  const moreBtn = $<HTMLButtonElement>('upload-more')

  const items: Item[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let wakeLock: any = null

  function add (files: File[], metadata: Record<string, string>) {
    for (const file of files) {
      const el = document.createElement('li')
      const label = document.createElement('span')
      label.className = 'file-name'
      label.textContent = file.webkitRelativePath || file.name
      const status = document.createElement('span')
      status.className = 'file-status'
      el.append(label, status)
      list?.prepend(el)
      const item: Item = { file, el, state: 'queued', loaded: 0, metadata }
      items.push(item)
      if (file.size > opts.maxBytes) setState(item, 'error', 'Too large')
      else setState(item, 'queued')
    }
    if (panel) panel.hidden = false
    requestWakeLock()
    pump()
  }

  function setState (item: Item, state: ItemState, message?: string) {
    item.state = state
    item.el.dataset.state = state
    const status = item.el.querySelector('.file-status') as HTMLElement
    const pct = item.file.size ? Math.floor(item.loaded / item.file.size * 100) : 0
    status.textContent = message || ({
      queued: 'Waiting…',
      uploading: pct + '%',
      saving: 'Saving…',
      done: 'Added ✓',
      error: 'Failed · tap to retry'
    } as Record<ItemState, string>)[state]
    if (state === 'error' && message !== 'Too large') {
      item.el.onclick = () => {
        item.el.onclick = null
        item.loaded = 0
        setState(item, 'queued')
        pump()
      }
    }
    render()
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
        setState(item, 'error', body && body.length < 80 ? body : undefined)
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
        await new Promise(resolve => setTimeout(resolve, 2000))
        const waiting = items.filter(i => i.state === 'saving' && i.uploadId)
        if (!waiting.length) continue
        try {
          const res = await fetch('/share/upload/status?ids=' + waiting.map(i => i.uploadId).join(','), { cache: 'no-store' })
          const statuses: Array<{ id: string, status: string }> = await res.json()
          for (const s of statuses) {
            const item = waiting.find(i => i.uploadId === s.id)
            if (!item) continue
            if (s.status === 'done') setState(item, 'done')
            else if (s.status === 'error') setState(item, 'error', 'Could not save')
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

  function render () {
    const total = items.length
    if (!total) return
    const done = items.filter(i => i.state === 'done').length
    const failed = items.filter(i => i.state === 'error').length
    const isBusy = busy()
    const bytesTotal = items.reduce((n, i) => n + i.file.size, 0) || 1
    const bytesDone = items.reduce((n, i) => n + (i.state === 'done' || i.state === 'saving' ? i.file.size : i.loaded), 0)
    if (barFill) barFill.style.width = Math.min(100, bytesDone / bytesTotal * 100) + '%'

    if (isBusy) {
      if (title) title.textContent = `Adding photos… ${done} of ${total}`
      if (hint) hint.hidden = false
    } else {
      if (title) title.textContent = opts.doneTitle(done, failed)
      if (hint) hint.hidden = true
      releaseWakeLock()
      opts.onAllDone?.()
    }
    if (viewBtn) viewBtn.hidden = isBusy || !done
    if (moreBtn) moreBtn.hidden = isBusy
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
    if (document.visibilityState === 'visible' && panel && !panel.hidden && busy()) requestWakeLock()
  })

  return { add, busy }
}
