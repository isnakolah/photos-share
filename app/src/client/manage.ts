// Album management on the album page: delete photos (from the selection
// toolbar or the lightbox), and for the owner, album settings (rename,
// people, delete album). The server re-checks every permission.

import { state } from './state.js'
import { enterSelectMode, exitSelectMode } from './selection.js'
import { computeLayoutAndRender } from './virtualisation.js'
import { buildDataSource } from './lightbox.js'
import type { InitParams } from '../shared/types.js'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null
const init: InitParams = JSON.parse(document.getElementById('ipp-init')?.textContent || '{}')
const albumId = init.albumId || ''

// ----- helpers -----------------------------------------------------------------

let toastTimer: number | undefined
export function toast (message: string) {
  const el = $('toast')
  if (!el) return
  el.textContent = message
  el.hidden = false
  el.classList.remove('toast-out')
  clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => {
    el.classList.add('toast-out')
    window.setTimeout(() => { el.hidden = true }, 250)
  }, 3200)
}

async function api<T> (method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch('/api' + path, {
    method,
    headers: { 'X-Requested-With': 'photos-share', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: 'no-store'
  })
  const data = await res.json().catch(() => ({}))
  if (res.status === 401) location.href = '/login?next=' + encodeURIComponent(location.pathname)
  if (!res.ok) throw new Error(data.error || 'Something went wrong. Try again.')
  return data as T
}

function plural (n: number, one: string, many: string) {
  return n + ' ' + (n === 1 ? one : many)
}

function showError (id: string, message: string | null) {
  const el = $(id)
  if (!el) return
  el.textContent = message || ''
  el.hidden = !message
}

for (const d of document.querySelectorAll('dialog')) {
  d.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => (d as HTMLDialogElement).close()))
  d.addEventListener('click', (e) => { if (e.target === d) (d as HTMLDialogElement).close() })
}

// ----- photo count in the header ------------------------------------------------

function setCount (n: number) {
  const sticker = document.querySelector('.album-head-count .sticker')
  if (sticker) sticker.textContent = plural(n, 'photo', 'photos')
}

// ----- deleting photos --------------------------------------------------------------

let pending: string[] = []

function openDelete (ids: string[]) {
  const dialog = $<HTMLDialogElement>('delete-dialog')
  const summary = $('delete-summary')
  if (!dialog || !summary) return
  const items = ids.map(id => state.items.find(it => it.id === id)).filter(it => it?.deleteKind)
  pending = items.map(it => it!.id)
  if (!pending.length) {
    toast('You can only delete photos you added.')
    return
  }
  const trash = items.filter(it => it!.deleteKind === 'trash').length
  const remove = items.length - trash
  const skipped = ids.length - items.length
  $('delete-title')!.textContent = 'Delete ' + plural(items.length, 'photo', 'photos') + '?'
  summary.replaceChildren()
  const line = (text: string) => { const li = document.createElement('li'); li.textContent = text; summary.append(li) }
  if (trash) line(`${plural(trash, 'photo', 'photos')} you added will go to the trash. You can restore them for 30 days.`)
  if (remove) line(`${plural(remove, 'photo', 'photos')} other people added will be taken out of this album. They stay in their owner's account.`)
  if (skipped) line(`${plural(skipped, 'photo isn\'t', 'photos aren\'t')} yours, so ${skipped === 1 ? 'it' : 'they'}'ll stay.`)
  showError('delete-error', null)
  const confirm = $<HTMLButtonElement>('delete-confirm')!
  confirm.textContent = 'Delete ' + plural(items.length, 'photo', 'photos')
  confirm.disabled = false
  dialog.showModal()
}

/** Take deleted photos out of the grid and the lightbox without a reload. */
function removeFromPage (ids: string[]) {
  const gone = new Set(ids)
  state.lightbox?.pswp?.close()
  state.items = state.items.filter(it => !gone.has(it.id))
  for (const id of ids) state.selected.delete(id)
  exitSelectMode()
  state.lastContainerW = 0 // force a full re-layout
  computeLayoutAndRender()
  if (state.lightbox) state.lightbox.options.dataSource = buildDataSource()
  setCount(state.items.length)
}

async function confirmDelete () {
  const confirm = $<HTMLButtonElement>('delete-confirm')!
  confirm.disabled = true
  confirm.textContent = 'Deleting…'
  try {
    const r = await api<{ trashed: string[], removed: string[], refused: string[] }>('POST', `/albums/${albumId}/assets/delete`, { ids: pending })
    $<HTMLDialogElement>('delete-dialog')?.close()
    removeFromPage([...r.trashed, ...r.removed])
    const done = r.trashed.length + r.removed.length
    toast(done ? `Deleted ${plural(done, 'photo', 'photos')}` + (r.refused.length ? `, ${r.refused.length} skipped` : '') : 'Nothing was deleted')
  } catch (e) {
    showError('delete-error', (e as Error).message)
    confirm.disabled = false
    confirm.textContent = 'Try again'
  }
}

function setupDelete () {
  $('select-start')?.addEventListener('click', () => enterSelectMode())
  const toolbarDelete = $<HTMLButtonElement>('select-delete')
  if (toolbarDelete) {
    toolbarDelete.addEventListener('click', () => openDelete([...state.selected]))
    document.addEventListener('ipp:selection', () => {
      toolbarDelete.disabled = ![...state.selected].some(id => state.items.find(it => it.id === id)?.deleteKind)
    })
  }
  document.addEventListener('ipp:delete-request', (e) => openDelete((e as CustomEvent<{ ids: string[] }>).detail.ids))
  $('delete-confirm')?.addEventListener('click', confirmDelete)
}

// ----- album settings (owner) -----------------------------------------------------

interface Person { id: string, name: string, email?: string, role?: 'owner' | 'editor' | 'viewer' }

const COLOURS = ['pink', 'sun', 'mint', 'grape', 'sky', 'coral']
function avatar (name: string) {
  let h = 0
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) >>> 0
  const parts = name.trim().split(/\s+/)
  const span = document.createElement('span')
  span.className = 'avatar avatar-sm c-' + COLOURS[h % COLOURS.length]
  span.textContent = (parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : (parts[0] || '?')[0]).toUpperCase()
  span.setAttribute('aria-hidden', 'true')
  return span
}

async function loadPeople () {
  const list = $('people-list')
  if (!list) return
  try {
    const { members, others } = await api<{ members: Person[], others: Person[] }>('GET', `/albums/${albumId}/people`)
    list.replaceChildren()
    for (const m of members) {
      const li = document.createElement('li')
      const who = document.createElement('span')
      who.className = 'person-name'
      who.append(avatar(m.name), document.createTextNode(m.name))
      li.append(who)
      if (m.role === 'owner') {
        const tag = document.createElement('span')
        tag.className = 'role-tag'
        tag.textContent = 'Owner'
        li.append(tag)
      } else {
        const select = document.createElement('select')
        select.setAttribute('aria-label', 'What ' + m.name + ' can do')
        for (const [value, label] of [['editor', 'Can add photos'], ['viewer', 'View only']]) {
          const o = document.createElement('option')
          o.value = value
          o.textContent = label
          o.selected = m.role === value
          select.append(o)
        }
        select.addEventListener('change', async () => {
          try {
            await api('PATCH', `/albums/${albumId}/people/${m.id}`, { role: select.value })
            toast(`${m.name} ${select.value === 'viewer' ? 'can now only view' : 'can add photos again'}`)
          } catch (e) { showError('people-error', (e as Error).message) }
        })
        const remove = document.createElement('button')
        remove.type = 'button'
        remove.className = 'icon-btn person-remove'
        remove.setAttribute('aria-label', 'Remove ' + m.name + ' from this album')
        remove.title = 'Remove from album'
        remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z"/></svg>'
        remove.addEventListener('click', async () => {
          // Two taps: the first turns into an explicit "Remove?" confirmation
          if (remove.dataset.armed !== '1') {
            remove.dataset.armed = '1'
            remove.className = 'btn btn-danger btn-sm person-remove'
            remove.textContent = 'Remove?'
            return
          }
          try {
            await api('DELETE', `/albums/${albumId}/people/${m.id}`)
            toast(`${m.name} can't see this album any more`)
            loadPeople()
          } catch (e) { showError('people-error', (e as Error).message) }
        })
        li.append(select, remove)
      }
      list.append(li)
    }
    const addWrap = $('add-person')
    const userSelect = $<HTMLSelectElement>('people-add-user')
    if (addWrap && userSelect) {
      userSelect.replaceChildren()
      for (const o of others) {
        const opt = document.createElement('option')
        opt.value = o.id
        opt.textContent = o.name + (o.email ? ' (' + o.email + ')' : '')
        userSelect.append(opt)
      }
      addWrap.hidden = others.length === 0
    }
  } catch (e) {
    list.replaceChildren()
    showError('people-error', (e as Error).message)
  }
}

function setupSettings () {
  const dialog = $<HTMLDialogElement>('album-settings')
  if (!dialog) return
  $('album-settings-open')?.addEventListener('click', () => {
    showError('people-error', null)
    showError('rename-error', null)
    dialog.showModal()
    loadPeople()
  })

  $<HTMLFormElement>('rename-form')?.addEventListener('submit', async (e) => {
    e.preventDefault()
    const name = $<HTMLInputElement>('album-rename')!.value.trim()
    if (!name) return
    try {
      await api('PATCH', `/albums/${albumId}`, { name })
      document.querySelector('.album-title-xl')!.textContent = name
      document.title = name + ' · Photos'
      toast('Album renamed')
      showError('rename-error', null)
    } catch (err) { showError('rename-error', (err as Error).message) }
  })

  $('people-add')?.addEventListener('click', async () => {
    const userId = $<HTMLSelectElement>('people-add-user')!.value
    const role = $<HTMLSelectElement>('people-add-role')!.value
    if (!userId) return
    try {
      await api('POST', `/albums/${albumId}/people`, { userId, role })
      toast('Added to the album')
      showError('people-error', null)
      loadPeople()
    } catch (e) { showError('people-error', (e as Error).message) }
  })

  const del = $<HTMLButtonElement>('delete-album')
  del?.addEventListener('click', async () => {
    if (del.dataset.armed !== '1') {
      del.dataset.armed = '1'
      del.textContent = 'Yes, delete this album'
      return
    }
    del.disabled = true
    del.textContent = 'Deleting…'
    try {
      const r = await api<{ url: string }>('POST', `/albums/${albumId}/delete`, { trashMine: $<HTMLInputElement>('delete-album-mine')?.checked === true })
      location.href = r.url
    } catch (e) {
      showError('delete-album-error', (e as Error).message)
      del.disabled = false
      del.textContent = 'Delete album'
      del.dataset.armed = ''
    }
  })
  dialog.addEventListener('close', () => {
    if (del) { del.dataset.armed = ''; del.textContent = 'Delete album' }
  })
}

// ----- Momento (admins) -------------------------------------------------------------

async function openInMomento (fresh: boolean) {
  // Open the tab right away (inside the click) so pop-up blockers allow it,
  // then point it at the design once Momento has it ready.
  const tab = window.open('about:blank', '_blank')
  if (tab) {
    tab.document.title = 'Opening in Momento…'
    tab.document.body.style.cssText = 'font: 600 18px system-ui; display: grid; place-items: center; height: 100vh; margin: 0; color: #241A4D'
    tab.document.body.textContent = 'Getting your album ready in Momento…'
  }
  toast(fresh ? 'Starting a fresh design…' : 'Opening in Momento…')
  try {
    const r = await api<{ url: string, existed: boolean, imported: number }>('POST', `/albums/${albumId}/momento`, { fresh })
    if (tab) tab.location.href = r.url
    else location.href = r.url
    const button = $('momento-open')
    if (button) {
      button.dataset.hasDraft = '1'
      const label = button.querySelector('span')
      if (label) label.textContent = 'Open in Momento'
    }
    toast(r.existed
      ? (r.imported ? `Opened your design with ${plural(r.imported, 'new photo', 'new photos')}` : 'Opened your design')
      : `Created a design with ${plural(r.imported, 'photo', 'photos')}`)
  } catch (e) {
    tab?.close()
    toast((e as Error).message)
  }
}

function setupMomento () {
  const button = $('momento-open')
  const dialog = $<HTMLDialogElement>('momento-dialog')
  if (!button) return
  button.addEventListener('click', () => {
    if (button.dataset.hasDraft === '1' && dialog) dialog.showModal()
    else openInMomento(false)
  })
  dialog?.querySelectorAll<HTMLButtonElement>('[data-momento-fresh]').forEach(b => b.addEventListener('click', () => {
    dialog.close()
    openInMomento(b.dataset.momentoFresh === '1')
  }))
}

setupDelete()
setupSettings()
setupMomento()
