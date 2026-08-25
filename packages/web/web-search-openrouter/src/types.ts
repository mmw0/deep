/**
 * Provider-private wire types for the OpenRouter chat-completions API with the
 * `:online` web-search plugin. Citations arrive as `annotations[]` on the
 * assistant message; these types do not create a dependency on `ctx.llm`.
 * @module @deepseek-ai/dsh-web-search-openrouter/types
 */

/**
 * Any annotation on the assistant message. Only `url_citation` entries carry
 * search sources; other annotation kinds are skipped, so every field is
 * optional and validated at the read site.
 */
export interface Annotation {
  type?: string | null
  url?: string | null
  title?: string | null
  /** The exact cited excerpt — mapped to the seam's `snippet`. */
  content?: string | null
}

/** The assistant message of a chat-completions choice. */
export interface ChatCompletionMessage {
  content?: string | null
  annotations?: Annotation[] | null
}

/** One choice of a chat-completions response. */
export interface ChatCompletionChoice {
  message?: ChatCompletionMessage
}

/** OpenRouter's chat-completions response envelope. */
export interface ChatCompletionResponse {
  choices?: ChatCompletionChoice[]
}

/** OpenRouter's error response envelope (best-effort; fields vary). */
export interface ChatCompletionError {
  error?: { message?: string | null } | string | null
  message?: string | null
}

/**
 * Exact secret-free OpenRouter search request recorded immediately before one
 * auxiliary search dispatch.
 */
export interface OpenRouterSearchLlmRequest {
  /** Fully resolved chat-completions endpoint. */
  readonly endpoint: string
  /** The model id sent (always carries the `:online` suffix). */
  readonly model: string
  /** Exact JSON body sent to the provider. */
  readonly body: {
    readonly model: string
    readonly max_tokens: number
    readonly messages: readonly [{
      readonly role: 'user'
      readonly content: string
    }]
  }
}
