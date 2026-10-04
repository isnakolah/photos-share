import { Confetti, Head, Sticker, Wordmark } from './layout'

interface PasswordProps {
  shareKey: string
  notifyInvalidPassword: boolean
}

const submitScript = `
  async function submitForm (formElement) {
    const formData = new FormData(formElement)
    try {
      const res = await fetch('/share/unlock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.fromEntries(formData.entries()))
      })
      if (res.status === 200) {
        window.location.reload()
      }
    } catch (e) { }
  }

  document.getElementById('unlock')
    .addEventListener('submit', function (e) {
      e.preventDefault()
      submitForm(this)
    })
`

export function Password ({ shareKey, notifyInvalidPassword }: PasswordProps) {
  return (
    <html lang="en">
      <Head title="Locked album · Photos"/>
      <body class="auth-page">
        <Confetti/>
        <main class="auth-wrap">
          <div class="auth-brand"><Wordmark/></div>
          <section class="auth-card">
            <Sticker tone="sun" tilt="left">Locked</Sticker>
            <h1 class="auth-title">This album has a password</h1>
            <p class="auth-meta">Whoever shared it can tell you what it is.</p>
            {notifyInvalidPassword && <p class="form-error" role="alert">That password isn't right. Try again.</p>}
            <form id="unlock" class="auth-form" method="post">
              <label class="field">
                <span>Password</span>
                <input type="password" name="password" required autoFocus autoComplete="current-password"/>
              </label>
              <input type="hidden" name="key" value={shareKey}/>
              <button class="btn btn-primary btn-block btn-lg" type="submit">Unlock album</button>
            </form>
          </section>
        </main>
        <script dangerouslySetInnerHTML={{ __html: submitScript }}/>
      </body>
    </html>
  )
}
