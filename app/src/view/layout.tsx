import type { ComponentChildren } from 'preact'
import { ThemeScript } from './theme'
import { ASSET_VERSION } from '../version'
import type { Account } from '../account/session'

/*
  Shared page chrome for photos-share: <head>, top bar, avatars, stickers.
  Visual language ("party album"): chunky ink-outlined pill buttons with an
  offset shadow, tilted sticker labels, Bricolage Grotesque for display type.
*/

export function Head (props: { title: string, description?: string, extraCss?: string[] }) {
  return (
    <head>
      <ThemeScript/>
      <meta charSet="utf-8"/>
      <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover"/>
      <meta name="robots" content="noindex, nofollow, noarchive, noimageindex"/>
      <meta name="theme-color" content="#FBFAFF" media="(prefers-color-scheme: light)"/>
      <meta name="theme-color" content="#17112F" media="(prefers-color-scheme: dark)"/>
      <title>{props.title}</title>
      <meta property="og:title" content={props.title}/>
      {props.description && <>
        <meta name="description" content={props.description}/>
        <meta property="og:description" content={props.description}/>
      </>}
      <meta property="og:site_name" content="Photos"/>
      <link rel="icon" href="/share/static/favicon.ico" type="image/x-icon"/>
      <link rel="preload" href="/share/static/fonts/bricolage-grotesque-latin-var.woff2" as="font" type="font/woff2" crossOrigin="anonymous"/>
      <link type="text/css" rel="stylesheet" href={`/share/static/${ASSET_VERSION}/style.css`}/>
      {props.extraCss?.map(href => <link type="text/css" rel="stylesheet" href={href}/>)}
    </head>
  )
}

const AVATAR_COLOURS = ['pink', 'sun', 'mint', 'grape', 'sky', 'coral']

/** Stable colour per person, so the same friend always gets the same bubble. */
export function avatarColour (name: string): string {
  let h = 0
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) >>> 0
  return AVATAR_COLOURS[h % AVATAR_COLOURS.length]
}

export function initials (name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  const letters = parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : (parts[0] || '?')[0]
  return letters.toUpperCase()
}

export function Avatar (props: { name: string, size?: 'xs' | 'sm' | 'md' | 'lg', title?: string }) {
  return (
    <span class={`avatar avatar-${props.size || 'md'} c-${avatarColour(props.name)}`} title={props.title ?? props.name} aria-hidden="true">
      {initials(props.name)}
    </span>
  )
}

export function Sticker (props: { children: ComponentChildren, tone?: 'sun' | 'pink' | 'mint', tilt?: 'left' | 'right' }) {
  return <span class={`sticker sticker-${props.tone || 'sun'} tilt-${props.tilt || 'left'}`}>{props.children}</span>
}

export function Wordmark () {
  return (
    <a class="wordmark" href="/" aria-label="Photos home">
      <span class="wordmark-dots" aria-hidden="true"><i/><i/><i/></span>
      <span>photos</span>
    </a>
  )
}

export function TopBar (props: { account?: Account }) {
  return (
    <header class="topbar">
      <div class="topbar-inner">
        <Wordmark/>
        {props.account && (
          <details class="account-menu">
            <summary aria-label={'Account menu for ' + props.account.name}>
              <Avatar name={props.account.name} size="sm" title=""/>
              <span class="account-name">{props.account.name}</span>
            </summary>
            <div class="account-popover">
              <p class="account-email">{props.account.email}</p>
              <form method="post" action="/logout"><button class="btn btn-ghost btn-block" type="submit">Sign out</button></form>
            </div>
          </details>
        )}
      </div>
    </header>
  )
}

/** Decorative confetti for the signed-out and empty screens. */
export function Confetti () {
  return (
    <div class="confetti" aria-hidden="true">
      <i class="c1"/><i class="c2"/><i class="c3"/><i class="c4"/><i class="c5"/><i class="c6"/><i class="c7"/><i class="c8"/>
    </div>
  )
}

export function Page (props: {
  title: string
  description?: string
  account?: Account
  bodyClass?: string
  extraCss?: string[]
  children?: ComponentChildren
  scripts?: ComponentChildren
}) {
  return (
    <html lang="en">
      <Head title={props.title} description={props.description} extraCss={props.extraCss}/>
      <body class={props.bodyClass}>
        <TopBar account={props.account}/>
        {props.children}
        {props.scripts}
      </body>
    </html>
  )
}
