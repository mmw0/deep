/**
 * Keyless fast-path retrieval: Bing's public results page. One GET returns
 * organic results whose titles, redirect-wrapped URLs, and snippets map onto
 * the seam's sources; no key, no quota, sub-second latency. Parsing is
 * intentionally tolerant — a layout change yields zero sources (the provider
 * then falls back to the OpenRouter stage) rather than a throw.
 * @module @deepseek-ai/dsh-web-search-openrouter/bing
 */

import type { WebSearchSource } from '@deepseek-ai/dsh-web'

/** Bing's public results endpoint. */
export const BING_SEARCH_URL = 'https://www.bing.com/search'

/** Attribution header sent on every request. Bump with the package version. */
const USER_AGENT = 'deepseek-harness/0.1.1-rc.2'

/** A realistic desktop browser agent: Bing serves the full layout to it. */
const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

/** True when the anchor href is Bing's click-tracking redirect. */
function isBingRedirect(href: string): boolean {
  return href.startsWith('https://www.bing.com/ck/') || href.startsWith('/ck/a')
}

/**
 * Decode one Bing redirect href to its destination URL. The `u` query
 * parameter carries `a1` + base64url-encoded bytes of the real URL; a value
 * that is absent, undecodable, or not http(s) yields `undefined`. The href may
 * carry HTML-escaped ampersands (`&amp;`), which are normalized first.
 *
 * @param href - the anchor href from a results page.
 * @returns the destination URL, or `undefined` when it cannot be recovered.
 */
export function decodeBingUrl(href: string): string | undefined {
  const normalized = href.replace(/&amp;/gu, '&')
  if (!isBingRedirect(normalized)) return normalized.startsWith('http') ? normalized : undefined
  const match = /[?&]u=([A-Za-z0-9_-]+)/.exec(normalized)
  if (match === null) return undefined
  const encoded = match[1] ?? ''
  if (encoded.length <= 2) return undefined
  try {
    const base64 = encoded.slice(2).replace(/-/gu, '+').replace(/_/gu, '/')
    const decoded = Buffer.from(base64, 'base64').toString('utf8')
    return decoded.startsWith('http') ? decoded : undefined
  } catch {
    return undefined
  }
}

/** Strip tags and decode entities in one extracted HTML fragment. */
function textOf(fragment: string): string {
  return fragment
    .replace(/<[^>]+>/gu, '')
    .replace(/&amp;/gu, '&')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/&nbsp;/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

/**
 * Parse Bing's organic results out of one results page. Each `<li
 * class="b_algo">` carries an `<h2><a href>` title link and a snippet `<p>`;
 * URLs decode through {@link decodeBingUrl} and dedupe by URL, first
 * occurrence winning, capped at `maxResults`.
 *
 * @param html - the fetched results page.
 * @param maxResults - the cap on accepted sources.
 * @returns the parsed sources; empty when the page carries none.
 */
export function parseBingResults(html: string, maxResults: number): WebSearchSource[] {
  const sources: WebSearchSource[] = []
  const seen = new Set<string>()
  const items = html.match(/<li class="b_algo"[^>]*>[\s\S]*?<\/li>/gu) ?? []
  for (const item of items) {
    if (sources.length >= maxResults) break
    const link = /<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(item)
    if (link === null) continue
    const url = decodeBingUrl(link[1] ?? '')
    const title = textOf(link[2] ?? '')
    if (url === undefined || url.length === 0 || seen.has(url)) continue
    const snippetMatch = /<p[^>]*>([\s\S]*?)<\/p>/.exec(item)
    const snippet = snippetMatch === null ? '' : textOf(snippetMatch[1] ?? '')
    seen.add(url)
    sources.push({
      url,
      ...title.length > 0 ? { title } : {},
      ...snippet.length > 0 ? { snippet } : {},
    })
  }
  return sources
}

/**
 * Fetch one Bing results page and parse it. A non-2xx status, a network
 * failure, or a parsed-empty page all throw — the caller treats the fast path
 * as best-effort and falls back to the OpenRouter stage.
 *
 * @param query - the search query.
 * @param maxResults - the cap on accepted sources.
 * @param signal - cancellation signal forwarded to the fetch.
 * @returns the parsed sources (at least one, or this throws).
 * @throws Error when retrieval or parsing yields nothing usable.
 */
export async function bingSearch(
  query: string,
  maxResults: number,
  signal?: AbortSignal,
): Promise<WebSearchSource[]> {
  const url = `${BING_SEARCH_URL}?q=${encodeURIComponent(query)}&count=${Math.max(maxResults, 10)}`
  const response = await fetch(url, {
    method: 'GET',
    redirect: 'follow',
    headers: {
      'user-agent': BROWSER_UA,
      'accept': 'text/html,application/xhtml+xml',
      'accept-language': 'en-US,en;q=0.9',
      'referer': 'https://www.bing.com/',
      'x-search-source': USER_AGENT,
    },
    ...signal !== undefined ? { signal } : {},
  })
  if (!response.ok) throw new Error(`Bing returned HTTP ${response.status}`)
  const html = await response.text()
  const sources = parseBingResults(html, maxResults)
  if (sources.length === 0) throw new Error('Bing returned no parseable organic results')
  return sources
}
