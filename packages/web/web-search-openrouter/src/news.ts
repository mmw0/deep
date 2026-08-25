/**
 * Keyless news retrieval: Google News's RSS search. One GET returns fresh
 * headline items with titles (which carry the source name), redirect links,
 * and publication dates — exactly the current-events coverage a generic web
 * results page lacks. Parsing is tolerant: a feed change yields zero items and
 * the caller simply carries on without the news stage.
 * @module @deepseek-ai/dsh-web-search-openrouter/news
 */

import type { WebSearchSource } from '@deepseek-ai/dsh-web'

/** Google News's RSS search endpoint. */
export const GOOGLE_NEWS_RSS_URL = 'https://news.google.com/rss/search'

/** A realistic browser agent: the feed serves full items to it. */
const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

/**
 * Queries that plainly seek current events. Deliberately conservative: a bare
 * "latest" (as in "latest python version") must NOT flip a query into the news
 * stage, while "latest developments" does.
 */
const NEWS_INTENT = /\b(news|headline|headlines|breaking|today|yesterday|this week|current events|latest developments|top stories)\b/iu

/**
 * Whether one query should also consult the news stage.
 *
 * @param query - the search query.
 * @returns true for current-events phrasing.
 */
export function isNewsIntentQuery(query: string): boolean {
  return NEWS_INTENT.test(query)
}

/** Decode the five XML entities an RSS field can carry. */
function xmlText(fragment: string): string {
  return fragment
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/&amp;/gu, '&')
    .replace(/&#(\d+);/gu, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/\s+/gu, ' ')
    .trim()
}

/**
 * Parse one Google News RSS document into sources. Each `<item>` carries a
 * title (which ends in " - Source Name"), a news.google.com redirect link, a
 * `pubDate`, and a `<source>` element. Items dedupe by URL, first occurrence
 * winning, capped at `maxResults`.
 *
 * @param xml - the fetched RSS document.
 * @param maxResults - the cap on accepted items.
 * @returns the parsed sources; empty when the feed carries none.
 */
export function parseGoogleNewsRss(xml: string, maxResults: number): WebSearchSource[] {
  const sources: WebSearchSource[] = []
  const seen = new Set<string>()
  const items = xml.match(/<item>[\s\S]*?<\/item>/gu) ?? []
  for (const item of items) {
    if (sources.length >= maxResults) break
    const titleMatch = /<title>([\s\S]*?)<\/title>/.exec(item)
    const linkMatch = /<link>([\s\S]*?)<\/link>/.exec(item)
    if (titleMatch === null || linkMatch === null) continue
    const title = xmlText(titleMatch[1] ?? '')
    const url = xmlText(linkMatch[1] ?? '')
    if (title.length === 0 || url.length === 0 || seen.has(url)) continue
    seen.add(url)
    const publishedAt = (() => {
      const dateMatch = /<pubDate>([\s\S]*?)<\/pubDate>/.exec(item)
      if (dateMatch === null) return undefined
      const parsed = new Date(xmlText(dateMatch[1] ?? ''))
      return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString()
    })()
    sources.push({
      url,
      title,
      ...publishedAt !== undefined ? { publishedAt } : {},
    })
  }
  return sources
}

/**
 * Fetch one Google News RSS search and parse it. A non-2xx status, a network
 * failure, or a parsed-empty feed all throw — the caller treats the news stage
 * as best-effort.
 *
 * @param query - the search query.
 * @param maxResults - the cap on accepted items.
 * @param signal - cancellation signal forwarded to the fetch.
 * @returns the parsed items (at least one, or this throws).
 * @throws Error when retrieval or parsing yields nothing usable.
 */
export async function googleNewsSearch(
  query: string,
  maxResults: number,
  signal?: AbortSignal,
): Promise<WebSearchSource[]> {
  const url = `${GOOGLE_NEWS_RSS_URL}?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`
  const response = await fetch(url, {
    method: 'GET',
    redirect: 'follow',
    headers: {
      'user-agent': BROWSER_UA,
      'accept': 'application/rss+xml, application/xml, text/xml, */*',
      'accept-language': 'en-US,en;q=0.9',
    },
    ...signal !== undefined ? { signal } : {},
  })
  if (!response.ok) throw new Error(`Google News returned HTTP ${response.status}`)
  const xml = await response.text()
  const sources = parseGoogleNewsRss(xml, maxResults)
  if (sources.length === 0) throw new Error('Google News returned no parseable items')
  return sources
}
