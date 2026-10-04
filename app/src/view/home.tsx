import { Avatar, Page, Sticker } from './layout'
import { ASSET_VERSION } from '../version'
import type { Account } from '../account/session'

export interface AlbumCard {
  id: string
  name: string
  count: number
  ownerName: string
  cover: string | null
  // Album page URL, or null when it has no invite link yet
  url: string | null
  memberNames: string[]
}

export interface HomeProps {
  account: Account
  owned: AlbumCard[]
  shared: AlbumCard[]
  canCreate: boolean
}

function Card (props: { album: AlbumCard, mine: boolean }) {
  const a = props.album
  const people = a.memberNames.slice(0, 4)
  const inner = (
    <>
      <div class="album-cover">
        {a.cover
          ? <img src={a.cover} alt="" loading="lazy" decoding="async"/>
          : <span class="album-cover-empty" aria-hidden="true">📷</span>}
        <span class="album-count">
          <Sticker tone="sun" tilt="right">{a.count} {a.count === 1 ? 'photo' : 'photos'}</Sticker>
        </span>
      </div>
      <div class="album-body">
        <h3 class="album-title">{a.name}</h3>
        <div class="album-people">
          <span class="avatar-stack">
            {people.map(n => <Avatar name={n} size="sm"/>)}
          </span>
          <span class="album-by">{props.mine ? (a.memberNames.length > 1 ? `You and ${a.memberNames.length - 1} more` : 'Only you so far') : `From ${a.ownerName}`}</span>
        </div>
      </div>
    </>
  )
  return a.url
    ? <a class="album-card" href={a.url}>{inner}</a>
    : <div class="album-card album-card-disabled" title="This album has no invite link yet">{inner}</div>
}

export function Home (props: HomeProps) {
  const first = props.account.name.split(/\s+/)[0]
  const nothing = !props.owned.length && !props.shared.length
  return (
    <Page
      title="Your albums · Photos"
      account={props.account}
      bodyClass="home-page"
      scripts={<script type="module" src={`/share/static/${ASSET_VERSION}/js/client/home.js`}></script>}
    >
      <main class="container">
        <section class="hello">
          <h1 class="hello-title">Hey {first}!</h1>
          <p class="hello-sub">
            {nothing
              ? (props.canCreate ? 'Start an album, add your photos, then invite your people.' : 'Albums people share with you show up here.')
              : 'Here are your albums.'}
          </p>
          {props.canCreate && (
            <button id="new-album" class="btn btn-primary btn-lg" type="button">
              <span aria-hidden="true">＋</span> New album
            </button>
          )}
        </section>

        {props.owned.length > 0 && (
          <section class="album-section" aria-labelledby="owned-title">
            <h2 id="owned-title" class="section-title">Your albums</h2>
            <div class="album-grid">{props.owned.map(a => <Card album={a} mine={true}/>)}</div>
          </section>
        )}

        {props.shared.length > 0 && (
          <section class="album-section" aria-labelledby="shared-title">
            <h2 id="shared-title" class="section-title">Shared with you</h2>
            <div class="album-grid">{props.shared.map(a => <Card album={a} mine={false}/>)}</div>
          </section>
        )}

        {nothing && (
          <section class="empty-state">
            <Sticker tone="pink" tilt="right">Nothing here yet</Sticker>
            <p>{props.canCreate
              ? 'Your first album is one tap away.'
              : 'Open an invite link from a friend and the album will appear here.'}</p>
          </section>
        )}
      </main>

      {props.canCreate && (
        <dialog id="album-dialog" aria-labelledby="album-dialog-title">
          <form id="album-form" method="dialog">
            <h2 id="album-dialog-title">New album</h2>
            <p class="dialog-sub">Give it a name your friends will recognise.</p>
            <label class="field">
              <span>Album name</span>
              <input id="album-name" type="text" required maxLength={120} placeholder="Kericho Escapades" autoComplete="off"/>
            </label>
            <p class="form-error" id="album-error" hidden></p>
            <div class="dialog-actions">
              <button class="btn btn-primary" type="submit">Create album</button>
              <button class="btn btn-ghost" type="button" data-close>Cancel</button>
            </div>
          </form>
        </dialog>
      )}
    </Page>
  )
}
