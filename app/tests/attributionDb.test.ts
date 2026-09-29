import { describe, it, expect, beforeEach } from 'vitest'
import {
  closeDb,
  deletableAssetsFor,
  getByUploadIds,
  isProcessed,
  markDeleted,
  markDone,
  markError,
  openDb,
  recordPending,
  summaryByUploader,
  uploadersForAlbum
} from '../src/attribution/db'

const base = {
  shareKey: 'key1', albumId: 'album-1', albumName: 'Beach', filename: 'a.jpg',
  size: 1000, mimeType: 'image/jpeg', ip: '1.2.3.4', userAgent: 'test'
}

describe('attribution db', () => {
  beforeEach(() => {
    closeDb()
    openDb(':memory:')
  })

  it('records pending uploads idempotently and marks them done', () => {
    recordPending({ ...base, uploadId: 'u1', uploader: 'Amina' })
    recordPending({ ...base, uploadId: 'u1', uploader: 'Someone else' })
    expect(isProcessed('u1')).toBe(false)
    markDone('u1', 'asset-1', false)
    const [r] = getByUploadIds(['u1'])
    expect(r).toMatchObject({ uploader: 'Amina', assetId: 'asset-1', status: 'done', duplicate: false })
    expect(isProcessed('u1')).toBe(true)
  })

  it('maps assets to their first uploader within an album', () => {
    recordPending({ ...base, uploadId: 'u1', uploader: 'Amina' })
    recordPending({ ...base, uploadId: 'u2', uploader: 'Otieno' })
    recordPending({ ...base, uploadId: 'u3', uploader: 'Otieno', albumId: 'other' })
    markDone('u1', 'asset-1', false)
    markDone('u2', 'asset-1', true)
    markDone('u3', 'asset-3', false)
    const map = uploadersForAlbum('album-1')
    expect(map.get('asset-1')).toBe('Amina')
    expect(map.has('asset-3')).toBe(false)
  })

  it('never offers duplicates for deletion', () => {
    recordPending({ ...base, uploadId: 'u1', uploader: 'Otieno' })
    recordPending({ ...base, uploadId: 'u2', uploader: 'Otieno' })
    recordPending({ ...base, uploadId: 'u3', uploader: 'Otieno' })
    markDone('u1', 'new-asset', false)
    markDone('u2', 'hosts-own-photo', true)
    markError('u3', 'boom')
    expect(deletableAssetsFor('Otieno')).toEqual(['new-asset'])
  })

  it('hides deleted uploads from attribution and summaries', () => {
    recordPending({ ...base, uploadId: 'u1', uploader: 'Amina' })
    recordPending({ ...base, uploadId: 'u2', uploader: 'Amina' })
    markDone('u1', 'a1', false)
    markDone('u2', 'a2', false)
    markDeleted(['a1'])
    expect(uploadersForAlbum('album-1').has('a1')).toBe(false)
    expect(summaryByUploader()).toEqual([expect.objectContaining({ uploader: 'Amina', count: 1 })])
    expect(deletableAssetsFor('Amina')).toEqual(['a2'])
  })
})
