import { describe, expect, it } from 'vitest'
import { decodeBingUrl, parseBingResults } from '../src/bing.ts'
import { isNewsIntentQuery, parseGoogleNewsRss } from '../src/news.ts'
import { mapOpenRouterResponse, withOnlineSuffix } from '../src/provider.ts'
import type { ChatCompletionResponse } from '../src/types.ts'

function response(overrides: {
  content?: string | null
  annotations?: Array<Record<string, unknown>> | null
}): ChatCompletionResponse {
  const message = {
    ...(overrides.content !== undefined ? { content: overrides.content } : {}),
    ...(overrides.annotations !== undefined ? { annotations: overrides.annotations } : {}),
  }
  return { choices: [{ message }] }
}

describe('decodeBingUrl', () => {
  it('decodes a click-tracking redirect through the u parameter', () => {
    // a1 + base64url("https://example.com/page")
    const u = `a1${Buffer.from('https://example.com/page', 'utf8').toString('base64').replace(/\+/gu, '-').replace(/\//gu, '_')}`
    expect(decodeBingUrl(`https://www.bing.com/ck/a?!&&p=abc&u=${u}`)).toBe('https://example.com/page')
  })

  it('decodes a redirect whose href carries HTML-escaped ampersands', () => {
    const u = `a1${Buffer.from('https://example.com/a?b=1&c=2', 'utf8').toString('base64').replace(/\+/gu, '-').replace(/\//gu, '_')}`
    expect(decodeBingUrl(`https://www.bing.com/ck/a?!&amp;&amp;p=abc&amp;u=${u}`)).toBe('https://example.com/a?b=1&c=2')
  })

  it('keeps a plain absolute href and rejects undecodable redirects', () => {
    expect(decodeBingUrl('https://news.example/story')).toBe('https://news.example/story')
    expect(decodeBingUrl('https://www.bing.com/ck/a?!&&p=abc')).toBeUndefined()
    expect(decodeBingUrl('/relative/path')).toBeUndefined()
  })
})

describe('parseBingResults', () => {
  const redirectFor = (url: string): string =>
    `https://www.bing.com/ck/a?!&&p=x&u=a1${Buffer.from(url, 'utf8').toString('base64').replace(/\+/gu, '-').replace(/\//gu, '_')}`

  function bingPage(results: Array<{ url: string; title: string; snippet: string }>): string {
    const items = results.map(({ url, title, snippet }) => `
      <li class="b_algo"><h2><a href="${redirectFor(url)}">${title}</a></h2>
      <p>${snippet}</p></li>`).join('')
    return `<html><body><ol>${items}</ol></body></html>`
  }

  it('extracts titles, decoded URLs, and snippets, capped at maxResults', () => {
    const html = bingPage([
      { url: 'https://a.test/1', title: 'Result A &amp; more', snippet: 'Snippet <b>A</b>' },
      { url: 'https://b.test/2', title: 'Result B', snippet: 'Snippet B' },
    ])
    expect(parseBingResults(html, 8)).toEqual([
      { url: 'https://a.test/1', title: 'Result A & more', snippet: 'Snippet A' },
      { url: 'https://b.test/2', title: 'Result B', snippet: 'Snippet B' },
    ])
    expect(parseBingResults(html, 1)).toHaveLength(1)
  })

  it('dedupes by URL and skips items without a recoverable link', () => {
    const html = bingPage([{ url: 'https://a.test/1', title: 'A', snippet: 's' }])
      + `<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?!&&p=broken">No u</a></h2><p>x</p></li>`
      + bingPage([{ url: 'https://a.test/1', title: 'A duplicate', snippet: 's2' }])
    expect(parseBingResults(html, 8)).toEqual([{ url: 'https://a.test/1', title: 'A', snippet: 's' }])
  })

  it('a page with no organic results parses to an empty list', () => {
    expect(parseBingResults('<html><body>challenge page</body></html>', 8)).toEqual([])
  })
})

describe('isNewsIntentQuery', () => {
  it('flags current-events phrasing', () => {
    expect(isNewsIntentQuery("today's major news events")).toBe(true)
    expect(isNewsIntentQuery('breaking headlines')).toBe(true)
    expect(isNewsIntentQuery('top stories this week')).toBe(true)
    expect(isNewsIntentQuery('latest developments in the market')).toBe(true)
  })

  it('leaves technical queries alone', () => {
    expect(isNewsIntentQuery('python asyncio tutorial')).toBe(false)
    expect(isNewsIntentQuery('latest python version')).toBe(false)
    expect(isNewsIntentQuery('react hooks documentation')).toBe(false)
  })
})

describe('parseGoogleNewsRss', () => {
  const rss = `<?xml version="1.0"?><rss version="2.0"><channel>
<item><title>Sanctions announced &amp;#8212; Reuters</title><link>https://news.google.com/rss/articles/a1</link><pubDate>Tue, 25 Aug 2026 04:13:38 GMT</pubDate><source url="https://reuters.com">Reuters</source></item>
<item><title>Duplicate link</title><link>https://news.google.com/rss/articles/a1</link></item>
<item><title>No date item - BBC</title><link>https://news.google.com/rss/articles/b2</link></item>
</channel></rss>`

  it('extracts titles, links, and ISO publication dates, deduping by URL', () => {
    expect(parseGoogleNewsRss(rss, 8)).toEqual([
      {
        url: 'https://news.google.com/rss/articles/a1',
        title: 'Sanctions announced — Reuters',
        publishedAt: '2026-08-25T04:13:38.000Z',
      },
      { url: 'https://news.google.com/rss/articles/b2', title: 'No date item - BBC' },
    ])
  })

  it('caps the item count and tolerates an empty feed', () => {
    expect(parseGoogleNewsRss(rss, 1)).toHaveLength(1)
    expect(parseGoogleNewsRss('<rss></rss>', 8)).toEqual([])
  })
})

describe('withOnlineSuffix', () => {
  it('appends :online when missing', () => {
    expect(withOnlineSuffix('stealth/ox-alpha')).toBe('stealth/ox-alpha:online')
  })

  it('keeps an already-suffixed id unchanged', () => {
    expect(withOnlineSuffix('openrouter/free:online')).toBe('openrouter/free:online')
  })
})

describe('mapOpenRouterResponse', () => {
  it('maps content and url_citation annotations to sources with snippet excerpts', () => {
    const result = mapOpenRouterResponse(response({
      content: 'Here is what I found.',
      annotations: [
        { type: 'url_citation', url: 'https://a.test', title: 'A', content: 'excerpt for A' },
        { type: 'url_citation', url: 'https://b.test', title: 'B', content: 'excerpt for B' },
      ],
    }), 8)
    expect(result.content).toBe('Here is what I found.')
    expect(result.truncated).toBe(false)
    expect(result.sources).toEqual([
      { url: 'https://a.test', title: 'A', snippet: 'excerpt for A' },
      { url: 'https://b.test', title: 'B', snippet: 'excerpt for B' },
    ])
  })

  it('dedupes sources by url and skips malformed citations', () => {
    const result = mapOpenRouterResponse(response({
      content: 'Answer.',
      annotations: [
        { type: 'url_citation', url: 'https://a.test', title: 'A' },
        { type: 'url_citation', url: 'https://a.test', title: 'A again' },
        { type: 'url_citation', title: 'missing url' },
        { type: 'other_annotation', url: 'https://ignored.test' },
      ],
    }), 8)
    expect(result.sources).toEqual([{ url: 'https://a.test', title: 'A' }])
  })

  it('flags truncation when citations exceed maxUses and caps the list', () => {
    const annotations = [1, 2, 3].map(n => ({ type: 'url_citation', url: `https://${n}.test` }))
    const result = mapOpenRouterResponse(response({ content: 'Answer.', annotations }), 2)
    expect(result.sources).toHaveLength(2)
    expect(result.truncated).toBe(true)
  })

  it('omits absent optional fields and empty content', () => {
    const result = mapOpenRouterResponse(response({
      content: null,
      annotations: [{ type: 'url_citation', url: 'https://a.test', title: null, content: null }],
    }), 8)
    expect(result.content).toBeUndefined()
    expect(result.sources).toEqual([{ url: 'https://a.test' }])
  })

  it('a no-citation response is a successful empty result, not an error', () => {
    const result = mapOpenRouterResponse(response({ content: 'No relevant results.', annotations: null }), 8)
    expect(result.sources).toEqual([])
    expect(result.truncated).toBe(false)
    expect(result.content).toBe('No relevant results.')
  })

  it('throws WEB_PROVIDER_ERROR when no choice or message exists', () => {
    expect(() => mapOpenRouterResponse({ choices: [] }, 8)).toThrowError(/no choices/u)
    expect(() => mapOpenRouterResponse({ choices: [{}] }, 8)).toThrowError(/no choices/u)
  })
})
