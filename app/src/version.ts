import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * Resolve the running application version. Prefers the APP_VERSION env var
 * baked in at Docker build time (see Dockerfile); falls back to package.json
 * for local dev (`npm run dev`), and finally to 'dev' if neither is readable.
 */
function resolveVersion (): string {
  if (process.env.APP_VERSION) return process.env.APP_VERSION
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'))
    return pkg.version || 'dev'
  } catch {
    return 'dev'
  }
}

export const APP_VERSION = resolveVersion()

/**
 * URL-safe cache-busting segment for static asset paths. Includes the git
 * commit (GIT_SHA, baked in at Docker build time) so every deploy gets new
 * URLs: static files are cached as immutable by browsers and by Cloudflare,
 * and the package version alone doesn't change between our deploys.
 */
const GIT_SHA = (process.env.GIT_SHA || '').slice(0, 8)
export const ASSET_VERSION = encodeURIComponent(APP_VERSION + (GIT_SHA ? '-' + GIT_SHA : ''))
