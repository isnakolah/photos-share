import { describe, it, expect } from 'vitest'
import {
  cleanFilename,
  cleanUploaderName,
  fileDate,
  isAllowedMedia,
  passwordFromCookie,
  uploadGate
} from '../src/upload/validate'
import { encrypt } from '../src/encrypt'
import { KeyType, SharedLink } from '../src/types'

const link = (over: Partial<SharedLink> = {}): SharedLink => ({
  key: 'k', keyType: KeyType.key, type: 'ALBUM', assets: [], expiresAt: null,
  allowUpload: true, album: { id: 'album-1', albumName: 'Beach' }, ...over
})

describe('cleanUploaderName', () => {
  it('trims and collapses whitespace', () => {
    expect(cleanUploaderName('  Amina   W  ')).toBe('Amina W')
  })
  it('strips slashes so the tag hierarchy stays one level', () => {
    expect(cleanUploaderName('a/b\\c')).toBe('a b c')
  })
  it('rejects empty or non-string names', () => {
    expect(cleanUploaderName('   ')).toBeUndefined()
    expect(cleanUploaderName(undefined)).toBeUndefined()
    expect(cleanUploaderName(42)).toBeUndefined()
  })
  it('caps the length', () => {
    expect(cleanUploaderName('x'.repeat(200))?.length).toBe(40)
  })
})

describe('isAllowedMedia', () => {
  it('accepts image and video mime types', () => {
    expect(isAllowedMedia('a.bin', 'image/jpeg')).toBe(true)
    expect(isAllowedMedia('a.bin', 'video/quicktime')).toBe(true)
  })
  it('falls back to extension when the browser sends no type (HEIC, RAW)', () => {
    expect(isAllowedMedia('IMG_0001.HEIC', '')).toBe(true)
    expect(isAllowedMedia('DSC.ARW', 'application/octet-stream')).toBe(true)
  })
  it('rejects everything else', () => {
    expect(isAllowedMedia('evil.exe', 'application/x-msdownload')).toBe(false)
    expect(isAllowedMedia('notes.pdf', 'application/pdf')).toBe(false)
  })
})

describe('cleanFilename', () => {
  it('drops path components', () => {
    expect(cleanFilename('../../etc/passwd')).toBe('passwd')
    expect(cleanFilename('C:\\\\Users\\\\x\\\\IMG.jpg')).toBe('IMG.jpg')
  })
  it('never returns empty', () => {
    expect(cleanFilename('')).toBe('upload')
  })
})

describe('fileDate', () => {
  const now = new Date('2026-09-29T12:00:00Z')
  it('uses a sane lastModified', () => {
    expect(fileDate(String(Date.parse('2026-08-01T10:00:00Z')), now)).toBe('2026-08-01T10:00:00.000Z')
  })
  it('falls back to now for garbage or future dates', () => {
    expect(fileDate('nope', now)).toBe(now.toISOString())
    expect(fileDate('0', now)).toBe(now.toISOString())
    expect(fileDate(String(now.getTime() + 7 * 86400000), now)).toBe(now.toISOString())
  })
})

describe('uploadGate', () => {
  it('allows album links with upload enabled', () => {
    expect(uploadGate(link())).toEqual({ ok: true, albumId: 'album-1', albumName: 'Beach' })
  })
  it('refuses links without allowUpload', () => {
    expect(uploadGate(link({ allowUpload: false }))).toMatchObject({ ok: false, status: 403 })
  })
  it('refuses non-album links', () => {
    expect(uploadGate(link({ album: undefined }))).toMatchObject({ ok: false, status: 403 })
  })
  it('refuses a missing link', () => {
    expect(uploadGate(undefined)).toMatchObject({ ok: false, status: 404 })
  })
})

describe('passwordFromCookie', () => {
  const cookieFor = (key: string, payload: object) =>
    'other=1; session=' + Buffer.from(JSON.stringify({ [key]: encrypt(JSON.stringify(payload)) })).toString('base64')

  it('recovers an unexpired password for the matching key', () => {
    const expires = new Date(Date.now() + 3600e3).toISOString()
    expect(passwordFromCookie(cookieFor('abc', { password: 'pw', expires }), 'abc')).toBe('pw')
  })
  it('ignores other keys, expired payloads and junk', () => {
    const expires = new Date(Date.now() + 3600e3).toISOString()
    expect(passwordFromCookie(cookieFor('abc', { password: 'pw', expires }), 'xyz')).toBeUndefined()
    expect(passwordFromCookie(cookieFor('abc', { password: 'pw', expires: '2000-01-01' }), 'abc')).toBeUndefined()
    expect(passwordFromCookie('session=!!!notbase64', 'abc')).toBeUndefined()
    expect(passwordFromCookie(undefined, 'abc')).toBeUndefined()
  })
})
