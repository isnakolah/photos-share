import { Confetti, Head, Sticker, Wordmark } from './layout'

export interface InviteInfo {
  albumName: string
  ownerName: string
  count: number
  // The share key or slug this invite came from, and its type
  key: string
  keyType: 'key' | 'slug'
}

export interface AuthProps {
  // Where to go after signing in (always a same-site path)
  next: string
  invite?: InviteInfo
  tab: 'signup' | 'login'
  error?: string
  values?: { name?: string, email?: string }
}

/**
 * Sign-in / create-account screen. With an invite, it leads with the album
 * ("Daniel invited you to Kericho Escapades") and defaults to creating an
 * account; without one, it's a plain sign-in (accounts only come from invites).
 */
export function AuthPage (props: AuthProps) {
  const inv = props.invite
  const title = inv ? `${inv.ownerName} invited you to ${inv.albumName}` : 'Sign in · Photos'
  const description = inv ? `Join to see and add photos to "${inv.albumName}".` : 'Sign in to see your albums.'
  const canSignUp = !!inv
  const tab = canSignUp ? props.tab : 'login'

  return (
    <html lang="en">
      <Head title={title} description={description}/>
      <body class="auth-page">
        <Confetti/>
        <main class="auth-wrap">
          <div class="auth-brand"><Wordmark/></div>
          <section class="auth-card" aria-labelledby="auth-title">
            {inv
              ? <>
                  <Sticker tone="sun" tilt="left">You're invited!</Sticker>
                  <p class="auth-kicker">{inv.ownerName} shared an album with you</p>
                  <h1 id="auth-title" class="auth-title">{inv.albumName}</h1>
                  <p class="auth-meta">{inv.count} {inv.count === 1 ? 'photo' : 'photos'} so far. Join to see them and add yours.</p>
                </>
              : <>
                  <h1 id="auth-title" class="auth-title">Welcome back</h1>
                  <p class="auth-meta">Sign in to see your albums.</p>
                </>}

            {canSignUp && (
              <div class="segmented" role="tablist" aria-label="Account">
                <a role="tab" aria-selected={tab === 'signup' ? 'true' : 'false'} class={tab === 'signup' ? 'active' : ''}
                   href={'?tab=signup'}>I'm new here</a>
                <a role="tab" aria-selected={tab === 'login' ? 'true' : 'false'} class={tab === 'login' ? 'active' : ''}
                   href={'?tab=login'}>I have an account</a>
              </div>
            )}

            {props.error && <p class="form-error" role="alert">{props.error}</p>}

            {tab === 'signup' && inv
              ? (
                <form class="auth-form" method="post" action="/signup">
                  <input type="hidden" name="next" value={props.next}/>
                  <input type="hidden" name="invite" value={inv.key}/>
                  <input type="hidden" name="inviteType" value={inv.keyType}/>
                  <label class="field">
                    <span>Your name</span>
                    <input name="name" type="text" required maxLength={40} autoComplete="name" autoCapitalize="words"
                           value={props.values?.name || ''} placeholder="What friends call you"/>
                  </label>
                  <label class="field">
                    <span>Email</span>
                    <input name="email" type="email" required autoComplete="email" value={props.values?.email || ''}/>
                  </label>
                  <label class="field">
                    <span>Password</span>
                    <input name="password" type="password" required minLength={8} autoComplete="new-password"
                           aria-describedby="pw-hint"/>
                    <small id="pw-hint">At least 8 characters.</small>
                  </label>
                  <button class="btn btn-primary btn-block btn-lg" type="submit">Join the album</button>
                </form>
                )
              : (
                <form class="auth-form" method="post" action="/login">
                  <input type="hidden" name="next" value={props.next}/>
                  <label class="field">
                    <span>Email</span>
                    <input name="email" type="email" required autoComplete="username" value={props.values?.email || ''}/>
                  </label>
                  <label class="field">
                    <span>Password</span>
                    <input name="password" type="password" required autoComplete="current-password"/>
                  </label>
                  <button class="btn btn-primary btn-block btn-lg" type="submit">{inv ? 'Sign in and join' : 'Sign in'}</button>
                </form>
                )}
            <p class="auth-foot">
              {inv
                ? 'Photos stay private: only people with an account in this album can see them.'
                : 'New here? Ask a friend for an album invite link.'}
            </p>
          </section>
        </main>
      </body>
    </html>
  )
}

/** Full-page message for dead links, missing albums and failures. */
export function MessagePage (props: {
  title: string
  body: string
  sticker: string
  action?: { href: string, label: string }
  status?: string
}) {
  return (
    <html lang="en">
      <Head title={props.title + ' · Photos'}/>
      <body class="auth-page">
        <Confetti/>
        <main class="auth-wrap">
          <div class="auth-brand"><Wordmark/></div>
          <section class="auth-card message-card">
            <Sticker tone="pink" tilt="right">{props.sticker}</Sticker>
            <h1 class="auth-title">{props.title}</h1>
            <p class="auth-meta">{props.body}</p>
            {props.action && <a class="btn btn-primary btn-lg" href={props.action.href}>{props.action.label}</a>}
          </section>
        </main>
      </body>
    </html>
  )
}
