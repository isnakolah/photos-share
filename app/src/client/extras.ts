// photos-share additions to the gallery page: the share/QR dialog and the
// guest upload flow. Upload is only wired up when the server rendered the
// #ipp-upload config block (i.e. the link has "allow upload" on).

interface UploadConfig {
  shareKey: string
  maxBytes: number
}

// tus-js-client's browser bundle (served from /share/static/vendor) sets `window.tus`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const tus: any

const NAME_KEY = 'photos-share-name'
const CHUNK_SIZE = 50 * 1024 * 1024 // stays under Cloudflare's 100 MB request cap
const PARALLEL = 3

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null

function storedName (): string {
  try { return localStorage.getItem(NAME_KEY) || '' } catch (e) { return '' }
}

function saveName (name: string) {
  try { localStorage.setItem(NAME_KEY, name) } catch (e) { }
}

// ----- share dialog ----------------------------------------------------------

function setupShare () {
  const dialog = $<HTMLDialogElement>('share-dialog')
  const open = $<HTMLButtonElement>('share-open')
  if (!dialog || !open) return
  const url = $<HTMLInputElement>('share-url')
  const copy = $<HTMLButtonElement>('share-copy')

  open.addEventListener('click', async () => {
    // Phones get the native share sheet (WhatsApp etc.); desktops get the QR.
    if (navigator.share && matchMedia('(pointer: coarse)').matches) {
      try {
        await navigator.share({ title: document.title, url: url?.value || location.href })
        return
      } catch (e) {
        if ((e as Error).name === 'AbortError') return
      }
    }
    dialog.showModal()
  })
  $('share-close')?.addEventListener('click', () => dialog.close())
  copy?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(url?.value || location.href)
    } catch (e) {
      url?.select()
      document.execCommand('copy')
    }
    copy.textContent = 'Copied ✓'
    setTimeout(() => { copy.textContent = 'Copy link' }, 2000)
  })
}

// ----- uploads ---------------------------------------------------------------

type ItemState = 'queued' | 'uploading' | 'saving' | 'done' | 'error'

interface Item {
  file: File
  el: HTMLLIElement
  state: ItemState
  loaded: number
  uploadId?: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  upload?: any
}

function setupUpload () {
  const cfgEl = document.getElementById('ipp-upload')
  if (!cfgEl || typeof tus === 'undefined') return
  const cfg: UploadConfig = JSON.parse(cfgEl.textContent || '{}')

  const addBtn = $<HTMLButtonElement>('add-photos')
  const input = $<HTMLInputElement>('upload-input')
  const nameDialog = $<HTMLDialogElement>('name-dialog')
  const nameForm = $<HTMLFormElement>('name-form')
  const nameInput = $<HTMLInputElement>('uploader-name')
  const panel = $<HTMLElement>('upload-panel')
  const list = $<HTMLUListElement>('upload-list')
  const title = $<HTMLElement>('upload-title')
  const hint = $<HTMLElement>('upload-hint')
  const barFill = $<HTMLElement>('upload-bar-fill')
  const nameLabel = $<HTMLElement>('upload-name')
  const viewBtn = $<HTMLButtonElement>('upload-view')
  const moreBtn = $<HTMLButtonElement>('upload-more')
  if (!addBtn || !input || !nameDialog || !nameForm || !nameInput || !panel || !list) return

  const items: Item[] = []
  let pickAfterName = false
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let wakeLock: any = null

  const askName = (thenPick: boolean) => {
    pickAfterName = thenPick
    nameInput.value = storedName()
    nameDialog.showModal()
    nameInput.focus()
  }

  addBtn.addEventListener('click', () => {
    if (!storedName()) askName(true)
    else input.click()
  })
  $('empty-album')?.addEventListener('click', () => addBtn.click())
  moreBtn?.addEventListener('click', () => input.click())
  $('change-name')?.addEventListener('click', () => askName(false))
  $('name-cancel')?.addEventListener('click', () => nameDialog.close())
  viewBtn?.addEventListener('click', () => location.reload())

  nameForm.addEventListener('submit', (e) => {
    const name = nameInput.value.replace(/\s+/g, ' ').trim().slice(0, 40)
    if (!name) {
      e.preventDefault()
      return
    }
    saveName(name)
    if (nameLabel) nameLabel.textContent = name
    // Opening the picker straight from the submit gesture keeps iOS happy.
    if (pickAfterName) input.click()
  })

  input.addEventListener('change', () => {
    const files = Array.from(input.files || [])
    input.value = ''
    if (!files.length) return
    for (const file of files) addFile(file)
    showPanel()
    pump()
  })

  function addFile (file: File) {
    const el = document.createElement('li')
    const label = document.createElement('span')
    label.className = 'file-name'
    label.textContent = file.name
    const status = document.createElement('span')
    status.className = 'file-status'
    el.append(label, status)
    list!.prepend(el)
    const item: Item = { file, el, state: 'queued', loaded: 0 }
    if (file.size > cfg.maxBytes) {
      setState(item, 'error', 'Too large')
    } else {
      setState(item, 'queued')
    }
    items.push(item)
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
    if (state === 'error' && !message?.startsWith('Too large')) {
      item.el.onclick = () => {
        item.el.onclick = null
        item.loaded = 0
        setState(item, 'queued')
        pump()
      }
    }
    render()
  }

  function showPanel () {
    panel!.hidden = false
    if (nameLabel) nameLabel.textContent = storedName()
    requestWakeLock()
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
        shareKey: cfg.shareKey,
        uploader: storedName(),
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
    item.upload = upload
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

  function render () {
    const total = items.length
    if (!total) return
    const done = items.filter(i => i.state === 'done').length
    const failed = items.filter(i => i.state === 'error').length
    const busy = items.some(i => i.state === 'queued' || i.state === 'uploading' || i.state === 'saving')
    const bytesTotal = items.reduce((n, i) => n + i.file.size, 0) || 1
    const bytesDone = items.reduce((n, i) => n + (i.state === 'done' || i.state === 'saving' ? i.file.size : i.loaded), 0)
    if (barFill) barFill.style.width = Math.min(100, bytesDone / bytesTotal * 100) + '%'

    if (busy) {
      if (title) title.textContent = `Adding your photos… ${done} of ${total}`
      if (hint) hint.hidden = false
    } else {
      const noun = done === 1 ? 'photo' : 'photos'
      if (title) {
        title.textContent = failed
          ? `${done} ${noun} added · ${failed} didn't make it`
          : `✅ ${done} ${noun} added. Thanks, ${storedName()}!`
      }
      if (hint) hint.hidden = true
      releaseWakeLock()
    }
    if (viewBtn) viewBtn.hidden = busy || !done
    if (moreBtn) moreBtn.hidden = busy
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
    if (document.visibilityState === 'visible' && !panel.hidden) requestWakeLock()
  })
}

setupShare()
setupUpload()
