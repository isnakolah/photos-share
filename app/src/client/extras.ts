// photos-share additions to the gallery page: the share/QR dialog and the
// guest upload flow. Upload is only wired up when the server rendered the
// #ipp-upload config block (i.e. the link has "allow upload" on).

import { createUploader, uploadsAvailable } from './uploader.js'

interface UploadConfig {
  shareKey: string
  maxBytes: number
}

const NAME_KEY = 'photos-share-name'

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

// ----- guest uploads ---------------------------------------------------------

function setupUpload () {
  const cfgEl = document.getElementById('ipp-upload')
  if (!cfgEl || !uploadsAvailable()) return
  const cfg: UploadConfig = JSON.parse(cfgEl.textContent || '{}')

  const addBtn = $<HTMLButtonElement>('add-photos')
  const input = $<HTMLInputElement>('upload-input')
  const nameDialog = $<HTMLDialogElement>('name-dialog')
  const nameForm = $<HTMLFormElement>('name-form')
  const nameInput = $<HTMLInputElement>('uploader-name')
  const nameLabel = $<HTMLElement>('upload-name')
  if (!addBtn || !input || !nameDialog || !nameForm || !nameInput) return

  const uploader = createUploader({
    maxBytes: cfg.maxBytes,
    doneTitle: (done, failed) => {
      const noun = done === 1 ? 'photo' : 'photos'
      return failed
        ? `${done} ${noun} added · ${failed} didn't make it`
        : `✅ ${done} ${noun} added. Thanks, ${storedName()}!`
    }
  })

  let pickAfterName = false
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
  $('upload-more')?.addEventListener('click', () => input.click())
  $('change-name')?.addEventListener('click', () => askName(false))
  $('name-cancel')?.addEventListener('click', () => nameDialog.close())
  $('upload-view')?.addEventListener('click', () => location.reload())

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
    if (nameLabel) nameLabel.textContent = storedName()
    uploader.add(files, { shareKey: cfg.shareKey, uploader: storedName() })
  })
}

setupShare()
setupUpload()
