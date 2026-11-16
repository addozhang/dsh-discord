/**
 * The bilingual copy table's runtime contract (design 16.25). The type system
 * already forces both tables to share keys; these tests pin the parts types
 * cannot express — the fallback language, per-language spot values, and that
 * no English entry silently carries Chinese text (a missed translation).
 */

import { describe, expect, it } from 'vitest'

import { attachmentRejectionCopy, createCopy, type CopyTable } from '../src/i18n.js'

/** Every copy member that is a plain (non-function) string value. */
function stringEntries(copy: CopyTable): Array<[string, string]> {
  return Object.entries(copy).filter(([, value]) => typeof value === 'string') as Array<[string, string]>
}

const CJK = /[\u4e00-\u9fff]/u

describe('i18n copy tables', () => {
  it('defaults unknown languages to Chinese', () => {
    expect(createCopy('zh')).toBe(createCopy('zh'))
    expect(createCopy('en')).not.toBe(createCopy('zh'))
    // The function signature only admits 'zh' | 'en'; the runtime guard
    // still falls back rather than handing back an undefined table.
    expect(createCopy('fr' as 'zh')).toEqual(createCopy('zh'))
  })

  it('keeps both tables key-aligned at runtime', () => {
    expect(Object.keys(createCopy('en')).sort()).toEqual(Object.keys(createCopy('zh')).sort())
  })

  it('carries no Chinese text in the English table', () => {
    for (const [key, value] of stringEntries(createCopy('en'))) {
      expect(value, `en.${key} still contains Chinese`).not.toMatch(CJK)
    }
  })

  it('resolves spot values per language', () => {
    expect(createCopy('zh').stopStopped).toBe('🛑 已停止。')
    expect(createCopy('en').stopStopped).toBe('🛑 Stopped.')
    expect(createCopy('zh').interruptedMarker).toBe('*（已被中断）*')
    expect(createCopy('en').interruptedMarker).toBe('*(interrupted)*')
    // Function members produce the localized placeholder too.
    expect(createCopy('zh').bindConfirmPrompt('ws')).toContain('将为工作区「ws」')
    expect(createCopy('en').bindConfirmPrompt('ws')).toContain('workspace "ws"')
    // 16.114 attachment feedback must exist in both languages.
    expect(createCopy('zh').attachmentUnsupported).toContain('暂不支持')
    expect(createCopy('en').attachmentUnsupported).toContain('unsupported type')
    expect(createCopy('zh').mainlineFileFailed).toContain('附件')
    expect(createCopy('en').mainlineFileFailed).toContain('attached file')
    expect(createCopy('zh').imageModalityRejected).toContain('图片')
    expect(createCopy('en').imageModalityRejected).toContain('image input')
    expect(createCopy('zh').attachmentRejected).toContain('附件')
    expect(createCopy('en').attachmentRejected).toContain('attachment')
  })
})

describe('attachment rejection notice (16.114)', () => {
  it('only the modality reason points at the model', () => {
    expect(attachmentRejectionCopy('session/attachment-invalid', 'MODEL_DOES_NOT_SUPPORT_IMAGES', createCopy('zh')))
      .toBe(createCopy('zh').imageModalityRejected)
    expect(attachmentRejectionCopy('session/attachment-invalid', 'MODEL_DOES_NOT_SUPPORT_IMAGES', createCopy('en')))
      .toBe(createCopy('en').imageModalityRejected)
  })

  it('an invalid or oversized image points at the file', () => {
    for (const reason of ['INVALID_IMAGE', 'IMAGE_TOO_LARGE', 'IMAGE_TYPE_MISMATCH']) {
      expect(attachmentRejectionCopy('session/attachment-invalid', reason, createCopy('en')))
        .toBe(createCopy('en').attachmentRejected)
    }
  })

  it('an absent detail is treated as a file problem, never a model limit', () => {
    expect(attachmentRejectionCopy('session/attachment-invalid', undefined, createCopy('en')))
      .toBe(createCopy('en').attachmentRejected)
  })

  it('other Host codes are not attachment notices', () => {
    expect(attachmentRejectionCopy('session/agent-busy', 'MODEL_DOES_NOT_SUPPORT_IMAGES', createCopy('en'))).toBeUndefined()
    expect(attachmentRejectionCopy(undefined, undefined, createCopy('en'))).toBeUndefined()
  })
})
