/**
 * Web search through a two-stage cascade. Stage one is keyless Bing retrieval:
 * one GET of the public results page, parsed into sources in well under a
 * second. Stage two — reached when Bing is blocked, changes layout, or returns
 * nothing — is an OpenRouter `:online` model call whose answer text and
 * `url_citation` annotations map onto the seam's `content` and `sources`.
 * The wire formats and native `fetch` client are provider-private and do not
 * use `ctx.llm`.
 * @module @deepseek-ai/dsh-web-search-openrouter/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-session'
import { bingSearch } from './bing.ts'
import { googleNewsSearch, isNewsIntentQuery } from './news.ts'
import type {
  ChatCompletionError,
  ChatCompletionResponse,
  OpenRouterSearchLlmRequest,
} from './types.ts'

/** Stable id this provider registers under. */
export const OPENROUTER_PROVIDER_ID = 'openrouter-online'

/** Default endpoint: OpenRouter's OpenAI-compatible chat-completions base. */
export const OPENROUTER_DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1'

/**
 * Default model. A zero-price OpenRouter route, so searches do not consume the
 * free tier's daily request quota; `:online` is appended at dispatch time.
 */
export const OPENROUTER_DEFAULT_MODEL = 'stealth/ox-alpha'

/** Suffix turning any OpenRouter model into its web-search-enabled variant. */
export const ONLINE_SUFFIX = ':online'

/** Default upper bound on generated tokens for the completions request. */
export const OPENROUTER_DEFAULT_MAX_TOKENS = 4096

/** Default maximum cited sources accepted from one search. */
export const OPENROUTER_DEFAULT_MAX_USES = 8

/** Default retries for transient provider failures (429/5xx/network). */
export const OPENROUTER_DEFAULT_MAX_RETRIES = 2

/** Base delay between retries, doubled per attempt (ms). */
const RETRY_BASE_DELAY_MS = 1_500

/** Attribution header sent on every request. Bump with the package version. */
const USER_AGENT = 'deepseek-harness/0.1.1-rc.2'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Secret-free auxiliary OpenRouter search request recorded before dispatch. */
    'web/openrouter-search-llm-request': OpenRouterSearchLlmRequest
  }
}

/** Resolved provider options (the plugin's `apply` supplies credential and constant defaults). */
export interface OpenRouterSearchProviderOptions {
  /** Literal OpenRouter API key; when present it wins over {@link resolveApiKey}. */
  apiKey?: string
  /** Resolve the current OpenRouter API key for one search operation. */
  resolveApiKey?: () => Promise<string | undefined>
  /** Credential reference named by missing-credential diagnostics. */
  apiKeyEnv?: CredentialRef
  /** Endpoint base; `/chat/completions` is appended. */
  baseURL: string
  /** OpenRouter model id; `:online` is appended when missing. */
  model: string
  /** Upper bound on generated tokens for the completions request. */
  maxTokens: number
  /** Maximum cited sources accepted from one search. */
  maxUses: number
  /** Retries for transient provider failures (429/5xx/network). */
  maxRetries: number
  /**
   * Record the exact secret-free request immediately before dispatch. A throw
   * prevents dispatch so model-visible auxiliary input cannot escape logging.
   */
  recordRequest?: (request: OpenRouterSearchLlmRequest) => void
}

/**
 * Ensure a model id names its web-search variant: `m` and `m:online` both stay
 * `m:online`, while an already-suffixed id is returned unchanged.
 *
 * @param model - the configured model id.
 * @returns the model id with the `:online` suffix present.
 */
export function withOnlineSuffix(model: string): string {
  return model.endsWith(ONLINE_SUFFIX) ? model : `${model}${ONLINE_SUFFIX}`
}

/**
 * Map an OpenRouter chat-completions response to a normalized search result.
 * The assistant message's text becomes `content`; each `url_citation`
 * annotation becomes one source (URL required, excerpt as snippet), deduped by
 * URL and capped at `maxUses`. The web service owns the final `maxResults`
 * truncation, so `truncated` flags only the provider-side cap here.
 *
 * @param response - the parsed chat-completions response body.
 * @param maxUses - the provider-side cap on accepted citations.
 * @returns the normalized result with deduped sources.
 * @throws {@link WebError} when the response carries no choice or message.
 */
export function mapOpenRouterResponse(response: ChatCompletionResponse, maxUses: number): WebSearchResult {
  const message = response.choices?.[0]?.message
  if (message === undefined) {
    throw new WebError(
      'OpenRouter returned no choices; the online search request may have failed upstream',
      'WEB_PROVIDER_ERROR',
    )
  }
  const content = typeof message.content === 'string' && message.content.length > 0
    ? message.content
    : undefined
  const sources: WebSearchSource[] = []
  const seen = new Set<string>()
  let truncated = false
  for (const annotation of message.annotations ?? []) {
    if (annotation.type !== undefined && annotation.type !== null && annotation.type !== 'url_citation') continue
    const url = annotation.url
    if (typeof url !== 'string' || url.length === 0 || seen.has(url)) continue
    seen.add(url)
    if (sources.length >= maxUses) {
      truncated = true
      break
    }
    sources.push({
      url,
      ...typeof annotation.title === 'string' && annotation.title.length > 0 ? { title: annotation.title } : {},
      ...typeof annotation.content === 'string' && annotation.content.length > 0 ? { snippet: annotation.content } : {},
    })
  }
  return {
    ...content === undefined ? {} : { content },
    sources,
    truncated,
  }
}

/**
 * Merge the news and web fast-path sources: fresh headlines first (they carry
 * publication dates and answer current-events queries directly), then web
 * results, deduped by URL and capped. When only one stage produced sources it
 * stands alone.
 *
 * @param newsSources - the news-stage sources, when the news stage ran.
 * @param webSources - the web-stage sources, when it succeeded.
 * @param cap - the cap on the merged list.
 * @returns the merged sources (possibly empty).
 */
function mergeFastSources(
  newsSources: readonly WebSearchSource[] | undefined,
  webSources: readonly WebSearchSource[] | undefined,
  cap: number,
): WebSearchSource[] {
  const seen = new Set<string>()
  const merged: WebSearchSource[] = []
  for (const source of [...newsSources ?? [], ...webSources ?? []]) {
    if (seen.has(source.url)) continue
    seen.add(source.url)
    merged.push(source)
    if (merged.length >= cap) break
  }
  return merged
}

/**
 * The cascading search provider: keyless Bing retrieval first, the OpenRouter
 * `:online` model call as the fallback. Transient LLM-stage failures retry
 * before failing.
 */
export class OpenRouterSearchProvider implements WebSearchProvider {
  readonly id = OPENROUTER_PROVIDER_ID

  /**
   * @param resolveOptions - the options for the NEXT operation, snapshotted
   * once at each operation's entry so one search never mixes two sections. A
   * thunk rather than a value because the plugin's settings section can change
   * between searches, and re-registering the provider to carry a new endpoint
   * would make the seam's selection observable to the user as a flicker.
   */
  constructor(private readonly resolveOptions: () => OpenRouterSearchProviderOptions) {}

  available(): boolean {
    const options = this.resolveOptions()
    // The Bing stage is keyless, so the provider is usable with no credential
    // at all; the LLM fallback simply fails its own resolution when no key
    // exists, and the next search still serves the keyless stage.
    return URL.canParse(options.baseURL)
      && isPositiveInteger(options.maxTokens)
      && isPositiveInteger(options.maxUses)
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    // Stage one — keyless fast paths, run concurrently. Best-effort by design:
    // any failure (network, block page, layout change, empty parse) falls
    // through to the LLM stage below; only an abort surfaces as cancellation.
    const cap = request.maxResults ?? 8
    const web = bingSearch(request.query, cap, signal).catch((error: unknown) => {
      if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
      return undefined
    })
    const news = isNewsIntentQuery(request.query)
      ? googleNewsSearch(request.query, cap, signal).catch((error: unknown) => {
        if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
        return undefined
      })
      : undefined
    let fast: WebSearchSource[] | undefined
    try {
      const [webSources, newsSources] = await Promise.all([web, news])
      fast = mergeFastSources(newsSources, webSources, cap)
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
      fast = undefined
    }
    if (fast !== undefined && fast.length > 0) return { sources: fast, truncated: false }
    return this.searchOnline(request, signal)
  }

  /** Stage two: one OpenRouter `:online` chat-completions request. */
  private async searchOnline(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    // One snapshot for the whole operation: credential resolution awaits, and a
    // settings write landing inside that await must not send the key resolved
    // from the old section to the endpoint named by the new one.
    const options = this.resolveOptions()
    const apiKey = await this.apiKey(options, signal)
    throwIfSearchAborted(signal)
    const endpoint = `${options.baseURL}/chat/completions`
    const model = withOnlineSuffix(options.model)
    const body: OpenRouterSearchLlmRequest['body'] = {
      model,
      max_tokens: options.maxTokens,
      messages: [{
        role: 'user',
        content: `Search the web for the query: ${request.query}`
          + ` — answer concisely with the key findings, then list up to ${options.maxUses} of the most relevant sources you cited.`,
      }],
    }
    options.recordRequest?.({ endpoint, model, body })
    throwIfSearchAborted(signal)

    let attempt = 0
    // Bounded retry loop: a transient upstream failure (429/5xx/network) is
    // retried with backoff; anything else — including cancellation and missing
    // credentials — surfaces immediately.
    for (;;) {
      let response: Response
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          redirect: 'error',
          headers: {
            'authorization': `Bearer ${apiKey}`,
            'content-type': 'application/json',
            'accept': 'application/json',
            'user-agent': USER_AGENT,
          },
          body: JSON.stringify(body),
          ...signal !== undefined ? { signal } : {},
        })
      } catch (error: unknown) {
        if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
        if (attempt < options.maxRetries) {
          await delay(retryDelayMs(attempt), signal)
          attempt += 1
          continue
        }
        throw new WebError(`OpenRouter search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
      }

      if (response.ok) {
        try {
          const payload = await response.json() as ChatCompletionResponse
          return mapOpenRouterResponse(payload, options.maxUses)
        } catch (error: unknown) {
          if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
          if (error instanceof WebError) throw error
          throw new WebError(`OpenRouter returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
        }
      }

      const status = response.status
      let message = `OpenRouter API error (HTTP ${status})`
      try {
        const parsed = await response.json() as ChatCompletionError
        const detail = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message ?? parsed.message
        if (typeof detail === 'string' && detail.length > 0) message = detail
      } catch (error: unknown) {
        // An abort fired mid-body must surface as WEB_ABORTED, not be swallowed
        // into a generic HTTP-error message — cancellation is not a provider
        // error (the seam's cancellation contract).
        if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
        // Otherwise: the HTTP status is already captured in `message` above; a
        // malformed/non-JSON error body (normal for gateway 5xx/429s) can only
        // cost a richer provider message, never the real error.
      }
      const transient = status === 408 || status === 429 || status >= 500
      if (transient && attempt < options.maxRetries) {
        await delay(retryDelayMs(attempt), signal)
        attempt += 1
        continue
      }
      throw new WebError(message, 'WEB_PROVIDER_ERROR')
    }
  }

  /**
   * Resolve one operation's credential without retaining it on the provider.
   * @param options - the caller's snapshot, so the key and the endpoint it is sent to come from one section.
   * @param signal - abort signal for the surrounding search.
   * @returns the resolved key.
   */
  private async apiKey(options: OpenRouterSearchProviderOptions, signal?: AbortSignal): Promise<string> {
    throwIfSearchAborted(signal)
    if (options.apiKey !== undefined && options.apiKey.length > 0) return options.apiKey
    let resolved: string | undefined
    try {
      resolved = await abortable(options.resolveApiKey?.() ?? Promise.resolve(undefined), signal)
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
      throw new WebError(
        `OpenRouter search credential resolution failed: ${String(error)}`,
        'WEB_PROVIDER_ERROR',
        { cause: error },
      )
    }
    if (resolved !== undefined && resolved.length > 0) return resolved
    const ref = options.apiKeyEnv ?? 'OPENROUTER_API_KEY'
    throw new WebError(
      `OpenRouter search has no API key for "${ref}"; store it through the credentials service`
        + ' (the web Models page writes it), export it in the launching environment, or set a literal'
        + ' "apiKey" in the web-search-openrouter config',
      'WEB_PROVIDER_CREDENTIAL_MISSING',
    )
  }
}

/** Backoff before retry `attempt` (0-based): 1.5s, 3s, 6s, … capped at 12s. */
function retryDelayMs(attempt: number): number {
  return Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, 12_000)
}

/** Sleep that rejects with the provider's cancellation error when `signal` fires. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.reject(searchAborted(signal))
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(searchAborted(signal))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Race a same-process asynchronous preflight against caller cancellation. The
 * attached settlement handlers keep observing an uncooperative operation after
 * abort so a later rejection cannot become unhandled.
 */
function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return operation
  if (signal.aborted) return Promise.reject(searchAborted(signal))
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { reject(searchAborted(signal)) }
    signal.addEventListener('abort', onAbort, { once: true })
    void operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(new Error(String(error).replace(/^Error: /u, ''), { cause: error }))
      },
    )
  })
}

/** Throw the provider's stable cancellation error when the caller already aborted. */
function throwIfSearchAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw searchAborted(signal)
}

/** Build the provider's stable cancellation error while retaining the caller's reason. */
function searchAborted(signal?: AbortSignal, fallback?: unknown): WebError {
  return new WebError('OpenRouter search aborted', 'WEB_ABORTED', {
    cause: signal?.aborted === true ? signal.reason : fallback,
  })
}

/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

/** True for request limits that can be sent to the completions API. */
function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0
}
