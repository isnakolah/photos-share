# photos-share

A fork of [Immich Public Proxy](https://github.com/alangrainger/immich-public-proxy) that lets friends **add** photos to a shared Immich album, not just view them.

What it adds on top of upstream:

- **Accounts and invites**: a share link is an invite, not a key. Opening it signed out shows "Daniel invited you to <album>", where people create an account (a real Immich user) or sign in. Then they're added to the album. Every album page, photo, video and download needs a signed-in member.
- **Adding photos**: members who can edit upload files or whole folders. Uploads use tus with 50 MB chunks (past Cloudflare Tunnel's 100 MB limit, resumable) and go into Immich under the uploader's own account, so ownership records who added what.
- **Home page**: "Your albums" and "Shared with you"; the host can create albums and manage invite settings (who can add, download, short link, QR).
- **No crawlers**: search and AI bots get 403, every response is noindex, and link previews show the album title but never a photo.
- **Upload log and admin page** (LAN only): who added what, and removing someone's uploads from your albums.
- A "party album" design: Bricolage Grotesque and Figtree, chunky outlined buttons, sticker labels, light and dark themes.

Deployment for nomonhomelab lives in [`deploy/`](deploy/): an Immich stack plus this proxy, published at `photos.nomonlab.com` via cf-dns. Pushes to `main` are tested on GitHub and deployed by a self-hosted runner.

Upload-related environment variables:

| Variable | Purpose |
|---|---|
| `IMMICH_API_KEY` | Host's API key (Immich admin): adminUser.create/read, albumUser.create, album.read, albumAsset.create/delete, sharedLink.read, asset.* |
| `FRIEND_QUOTA_GB` | Optional storage quota for accounts created from invites |
| `COOKIE_INSECURE` | `true` only for local http development |
| `UPLOAD_MAX_BYTES` | Per-file limit (default 10 GiB) |
| `UPLOAD_TMP_DIR` / `UPLOAD_DB_PATH` | Chunk storage and SQLite log (default `/data/...`) |
| `ADMIN_PORT` / `ADMIN_PASSWORD` | Admin page listener (default 3001, `0` disables) and its basic-auth password |
| `IMMICH_PUBLIC_URL` | Base URL for "open in Immich" links on the admin page |

Licensed AGPL-3.0 like upstream. This repository is the source for the running service.

---

# Immich Public Proxy

<p align="center" width="100%">
<img src="docs/public/ipp.svg" width="180" height="180">
</p>

<p align="center" width="100%">
<a href="https://hub.docker.com/r/alangrainger/immich-public-proxy/tags">
    <img alt="Docker pulls" src="https://badgen.net/docker/pulls/alangrainger/immich-public-proxy?icon=docker&label=docker%20pulls&color=green&scale=1.1"></a>
<a href="https://github.com/alangrainger/immich-public-proxy/releases/latest">
    <img alt="Latest release" src="https://badgen.net/github/tag/alangrainger/immich-public-proxy?scale=1.1&label=release"></a>
<a href="https://demo.ipp.nz/s/demo-gallery"><img alt="Open demo gallery" src="https://badgen.net/static/↗🖼️/live%20demo/green?scale=1.1"></a>
</p>

Share your Immich photos and albums in a safe way without exposing your Immich instance to the public.

👉 See a [Live demo gallery](https://demo.ipp.nz/s/demo-gallery)
serving straight out of my own Immich instance.

Setup takes less than a minute, and you never need to touch it again as all of your sharing stays managed within Immich.

<p align="center" width="100%">
<img src="docs/public/screenshot.webp" width="602" height="414" border="1px solid white">
</p>

## About this project

[Immich](https://github.com/immich-app/immich) is a wonderful bit of software, but since it holds all your private photos it's
best to keep it fully locked down. This presents a problem when you want to share a photo or a gallery with someone.

**Immich Public Proxy** provides a barrier of security between the public and Immich, and _only_ allows through requests
which you have publicly shared. It is stateless, needs no API key, and knows nothing about your Immich instance beyond
what you have shared.

Read more in the [Introduction](https://docs.ipp.nz/introduction), including
[why not just expose Immich's `/share/` path](https://docs.ipp.nz/introduction#why-not-expose-immich-directly).

## Quick start

1. Download the [docker-compose.yml](https://github.com/alangrainger/immich-public-proxy/blob/main/docker-compose.yml) file.
2. Set `IMMICH_URL` to the local (not public) URL of your Immich server, and `PUBLIC_BASE_URL` to the public URL of IPP.
3. Run `docker-compose up -d` and check that `https://your-proxy-url.com/share/healthcheck` responds.
4. In Immich's **Server Settings**, set the "External domain" to your IPP URL. Every link Immich generates from now on
   points at the proxy.

If you use Cloudflare, set your `/share/video/*` path to Bypass Cache or videos may not play.

Full instructions, including Kubernetes: **[Installation](https://docs.ipp.nz/installation)**.

## Documentation

Everything is at **[docs.ipp.nz](https://docs.ipp.nz)**:

- [Installation](https://docs.ipp.nz/installation) and [Sharing from Immich](https://docs.ipp.nz/how-to-use)
- [Configuration](https://docs.ipp.nz/config/): downloads, gallery layout, lightbox, metadata privacy, error responses
- Guides: [single domain with Immich](https://docs.ipp.nz/running-on-single-domain),
  [redirect your root domain to a share](https://docs.ipp.nz/redirect-root-to-share),
  [securing Immich with mTLS](https://docs.ipp.nz/securing-immich-with-mtls)
- [Troubleshooting](https://docs.ipp.nz/troubleshooting)

## Feature requests

You can [add feature requests here](https://github.com/alangrainger/immich-public-proxy/discussions/categories/feature-requests?discussions_q=is%3Aopen+category%3A%22Feature+Requests%22+sort%3Atop),
however my goal with this project is to keep it as lean as possible.

IPP has **read-only** access to Immich and stores nothing: anything that needs an API key, modifies Immich, or would
require storing a share key won't be considered. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full list.
