import { describe, expect, it } from 'vitest'
import { formatBrowserOutput, presentBrowserCall, presentBrowserResult } from '../src/index.ts'
import type { BrowserEnvelope } from '../src/index.ts'

const envelope = (overrides: Partial<BrowserEnvelope> = {}): BrowserEnvelope => ({
  ok: true,
  result: 'The page shows a welcome banner.',
  urls: ['https://example.com', 'https://example.com/docs'],
  steps: 3,
  duration_seconds: 21.5,
  ...overrides,
})

describe('formatBrowserOutput', () => {
  it('renders the answer, the URL trail, and the run stats', () => {
    const text = formatBrowserOutput(envelope(), 20_000)
    expect(text).toContain('The page shows a welcome banner.')
    expect(text).toContain('- https://example.com')
    expect(text).toContain('(3 steps, 21.5s)')
    expect(text).not.toContain('warnings')
  })

  it('surfaces warnings and an empty-answer fallback', () => {
    const text = formatBrowserOutput(envelope({ ok: false, result: '', error: 'nav timeout' }), 20_000)
    expect(text).toContain('The browser agent returned no final answer.')
    expect(text).toContain('warnings: nav timeout')
  })

  it('bounds the text to the configured cap', () => {
    const text = formatBrowserOutput(envelope({ result: 'x'.repeat(300) }), 100)
    expect(text.length).toBeLessThanOrEqual(120)
    expect(text).toContain('(truncated)')
  })
})

describe('presentation', () => {
  it('the pending card titles with the task and carries kind fetch', () => {
    expect(presentBrowserCall({ task: 'open the docs', url: 'https://a.test' })).toEqual({
      card: 'generic',
      title: 'https://a.test — open the docs',
      kind: 'fetch',
      rawInput: 'open the docs',
    })
  })

  it('the completed card keeps the same title shape', () => {
    expect(presentBrowserResult({ task: 'open the docs' })).toEqual({ card: 'generic', title: 'open the docs' })
  })
})
