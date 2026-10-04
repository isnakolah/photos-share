// Home page: the "New album" dialog. Creating an album also creates its
// invite link, then opens the album so photos can go straight in.

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null

function setupNewAlbum () {
  const button = $<HTMLButtonElement>('new-album')
  const dialog = $<HTMLDialogElement>('album-dialog')
  const form = $<HTMLFormElement>('album-form')
  const input = $<HTMLInputElement>('album-name')
  const error = $<HTMLElement>('album-error')
  if (!button || !dialog || !form || !input) return

  button.addEventListener('click', () => {
    input.value = ''
    if (error) error.hidden = true
    dialog.showModal()
    input.focus()
  })
  dialog.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => dialog.close()))
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close() })

  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    const name = input.value.trim()
    if (!name) return
    const submit = form.querySelector('button[type=submit]') as HTMLButtonElement
    submit.disabled = true
    submit.textContent = 'Creating…'
    try {
      const res = await fetch('/api/albums', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'photos-share' },
        body: JSON.stringify({ name })
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Couldn\'t create the album. Try again.')
      location.href = data.url
    } catch (err) {
      if (error) {
        error.textContent = (err as Error).message
        error.hidden = false
      }
      submit.disabled = false
      submit.textContent = 'Create album'
    }
  })
}

setupNewAlbum()
