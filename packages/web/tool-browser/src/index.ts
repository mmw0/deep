/**
 * Model-facing `browser_use` tool: drive a real Chromium browser through the
 * browser-use agent (https://github.com/browser-use/browser-use). The tool owns
 * only the model-facing schema, the subprocess boundary (a Python wrapper over
 * the installed `browser-use` package), the OpenRouter credential hand-off, and
 * result formatting — the browser agent plans and executes the navigation itself.
 * @module @deepseek-ai/dsh-tool-browser
 */

import type { Context } from '@deepseek-ai/cordis'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve as resolvePath } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, JsonValue, ToolResultView } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-browser'

/** Services required by the browser tool. */
export const inject = ['tools', 'systemPrompt']

/** Credential reference the browser agent's OpenRouter LLM resolves. */
const DEFAULT_API_KEY_ENV = 'OPENROUTER_API_KEY'

/** Default OpenRouter model driving the browser agent (zero-price route). */
export const DEFAULT_BROWSER_MODEL = 'stealth/ox-alpha'

/** Default cooperative tool-call timeout budget (ms): browser tasks are slow. */
export const DEFAULT_BROWSER_TOOL_TIMEOUT_MS = 300_000

/** Default step budget handed to the browser-use agent. */
export const DEFAULT_MAX_STEPS = 20

/** Default cap on the model-facing result text. */
export const DEFAULT_MAX_OUTPUT_CHARS = 20_000

/** Wrapper script shipped beside this package's lib output. */
const SCRIPT_PATH = resolvePath(fileURLToPath(new URL('../scripts/browser_use_agent.py', import.meta.url)))

/** Plugin config: subprocess location, model, budgets, and key reference. */
export interface Config {
  /** Python interpreter that has `browser-use` importable. Defaults to `python3`. */
  pythonPath?: string
  /** OpenRouter model driving the browser agent. Defaults to `stealth/ox-alpha`. */
  model?: string
  /** Credential reference resolved for each browser task. */
  apiKeyEnv?: string
  /** Step budget handed to the browser-use agent per call (1–50). Defaults to 20. */
  maxSteps?: number
  /** Cooperative timeout budget (ms) for `browser_use`. Defaults to 300000. */
  timeoutMs?: number
  /** Cap on the model-facing result characters. Defaults to 20000. */
  maxOutputChars?: number
}

export const Config: z<Config> = z.object({
  pythonPath: z.string().default('python3'),
  model: z.string().default(DEFAULT_BROWSER_MODEL),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  maxSteps: z.number().step(1).min(1).max(50).default(DEFAULT_MAX_STEPS),
  timeoutMs: z.number().default(DEFAULT_BROWSER_TOOL_TIMEOUT_MS),
  maxOutputChars: z.number().default(DEFAULT_MAX_OUTPUT_CHARS),
})

/** Complete config after schemastery applies every field default. */
type ResolvedConfig = Required<Config>

/** Model-facing `browser_use` arguments. */
interface BrowserToolArgs {
  task: string
  url?: string
  max_steps?: number
}

/** The Python wrapper's JSON envelope. */
export interface BrowserEnvelope {
  ok: boolean
  result: string
  urls: string[]
  steps: number
  duration_seconds: number
  error?: string
}

/**
 * Resolve the OpenRouter credential for one browser task: the credentials
 * service first, the launching environment as the ambient fallback.
 *
 * @param ctx - plugin context supplying the credential plane.
 * @param ref - the credential reference to resolve.
 * @returns the API key, or `undefined` when no layer supplies one.
 */
async function resolveApiKey(ctx: Context, ref: CredentialRef): Promise<string | undefined> {
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) return (await credentials.resolve(ref))?.value
  const ambient = launchEnvironmentOf(ctx).get(ref)
  return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined
}

/**
 * Run the Python browser-use wrapper once and collect its stdout envelope.
 *
 * @param python - interpreter command.
 * @param payload - the JSON payload written to the subprocess stdin.
 * @param env - the child environment (carries the resolved API key).
 * @param signal - cancellation signal forwarded to the child process.
 * @returns the parsed envelope.
 * @throws Error when the child exits without producing parseable JSON.
 */
export function runWrapper(
  python: string,
  payload: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<BrowserEnvelope> {
  return new Promise<BrowserEnvelope>((resolve, reject) => {
    const child = spawn(python, [SCRIPT_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...env, PYTHONUNBUFFERED: '1' },
    })
    let stdout = ''
    let stderr = ''
    const onAbort = (): void => { child.kill('SIGKILL') }
    signal.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.on('error', (error: Error) => {
      signal.removeEventListener('abort', onAbort)
      reject(new Error(`failed to launch the browser agent (${python}): ${String(error)}`))
    })
    child.on('close', (code: number | null) => {
      signal.removeEventListener('abort', onAbort)
      try {
        resolve(JSON.parse(stdout) as BrowserEnvelope)
      } catch {
        const tail = stderr.trim().split('\n').slice(-3).join(' | ')
        reject(new Error(
          `the browser agent exited (code ${String(code)}) without a result`
          + (tail.length > 0 ? `: ${tail.slice(0, 500)}` : ''),
        ))
      }
    })
    child.stdin.write(payload)
    child.stdin.end()
  })
}

/**
 * Format one envelope as the model-facing text: the answer, the visited URL
 * trail, and the run stats — bounded to `maxOutputChars`.
 *
 * @param envelope - the wrapper's outcome.
 * @param maxOutputChars - cap on the formatted text.
 * @returns the bounded result text.
 */
export function formatBrowserOutput(envelope: BrowserEnvelope, maxOutputChars: number): string {
  const parts: string[] = []
  parts.push(envelope.result.length > 0 ? envelope.result : 'The browser agent returned no final answer.')
  if (envelope.urls.length > 0) {
    parts.push(`Visited pages:\n${envelope.urls.map(url => `- ${url}`).join('\n')}`)
  }
  parts.push(`(${envelope.steps} steps, ${envelope.duration_seconds}s)`
    + (envelope.error !== undefined && envelope.error.length > 0 ? ` — warnings: ${envelope.error}` : ''))
  const text = parts.join('\n\n')
  return text.length <= maxOutputChars ? text : `${text.slice(0, maxOutputChars)}\n…(truncated)`
}

/**
 * Pending-call presentation: a generic card titled by the task.
 *
 * @param args - the raw tool arguments; the task text feeds the view.
 * @returns the generic card view (`kind: 'fetch'`) shown while the agent browses.
 */
export function presentBrowserCall(args: BrowserToolArgs): GenericCallView {
  const title = args.url !== undefined ? `${args.url} — ${args.task}` : args.task
  return { card: 'generic', title, kind: 'fetch', rawInput: args.task }
}

/**
 * Completed-call presentation: keep the pending card's title. The raw result
 * content (the same text `render` produced) fills the body.
 *
 * @param args - the raw tool arguments; the task text feeds the title.
 * @returns the generic result view.
 */
export function presentBrowserResult(args: BrowserToolArgs): ToolResultView {
  const title = args.url !== undefined ? `${args.url} — ${args.task}` : args.task
  return { card: 'generic', title }
}

/**
 * Replayable presentation meta: the visited URL trail and run stats.
 *
 * @param _args - the raw tool arguments (unused; the value carries everything).
 * @param value - the canonical `browser_use` output value.
 * @returns the structured URL list as opaque JSON.
 */
export function browserMetaFromValue(_args: BrowserToolArgs, value: BrowserEnvelope): JsonValue {
  return { urls: value.urls, steps: value.steps, ok: value.ok }
}

/**
 * Register the `browser_use` tool and its system-prompt guidance.
 *
 * @param ctx - context whose `tools` and `systemPrompt` registries receive the
 *   registrations; both are effect-scoped and unregister on plugin dispose.
 * @param config - the resolved plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  ctx.systemPrompt.section({
    name: 'tool:browser_use',
    order: 112,
    text: `Use the browser_use tool to complete tasks on the live web with a real browser: navigating sites, clicking, scrolling, filling forms, and reading dynamic content that web_search cannot see. Pass a single self-contained natural-language task (and optionally the starting url). Each call drives its own headless browser and can take up to a few minutes; reserve it for pages or interactions static search cannot answer, and prefer web_search for simple factual lookups. The result carries the agent's final answer plus the list of visited URLs.`,
  })

  ctx.tools.register(defineTool({
    name: 'browser_use',
    description: 'Drive a real headless browser to complete a web task: navigate, click, scroll, fill forms, and read dynamic page content that static search cannot access. Provide one self-contained task; optionally include the starting url. Returns the agent\'s final answer and the visited URLs.',
    parameters: {
      task: {
        type: 'string',
        required: true,
        description: 'The natural-language browser task to complete, self-contained and specific.',
      },
      url: {
        type: 'string',
        description: 'Optional starting URL to open before attempting the task.',
      },
      max_steps: {
        type: 'number',
        description: `Optional step budget for this task (default ${resolved.maxSteps}, max 50).`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          result: { type: 'string', required: true },
          urls: { type: 'array', required: true, items: { type: 'string' } },
          steps: { type: 'number', required: true },
          duration_seconds: { type: 'number', required: true },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatBrowserOutput(value, resolved.maxOutputChars) }],
      presentationMeta: (_args, value) => browserMetaFromValue(_args, value),
    },
    timeoutMs: resolved.timeoutMs,
    // One headless browser per call; sibling calls share no mutable parent state.
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const task = args.task.trim()
      if (task.length === 0) throw new Error('task must be a non-empty string')
      if (args.url !== undefined && !URL.canParse(args.url)) {
        throw new Error(`url must be an absolute URL, got ${JSON.stringify(args.url)}`)
      }
      const apiKeyRef = credentialRef(resolved.apiKeyEnv)
      const apiKey = await resolveApiKey(ctx, apiKeyRef)
      if (apiKey === undefined || apiKey.length === 0) {
        throw new Error(
          `browser_use has no API key for "${apiKeyRef}"; store it through the credentials service`
          + ' (the web Models page writes it), export it in the launching environment, or set'
          + ' OPENROUTER_API_KEY in the tool-browser config',
        )
      }
      const steps = args.max_steps !== undefined
        ? Math.max(1, Math.min(Math.trunc(args.max_steps), 50))
        : resolved.maxSteps
      const payload = JSON.stringify({
        task,
        ...(args.url !== undefined ? { url: args.url } : {}),
        max_steps: steps,
        model: resolved.model,
      })
      const env = {
        ...process.env,
        OPENROUTER_API_KEY: apiKey,
        BROWSER_USE_MODEL: resolved.model,
      }
      return await runWrapper(resolved.pythonPath, payload, env, exec.signal)
    },
    presentCall: presentBrowserCall,
    presentResult: (args: BrowserToolArgs) => presentBrowserResult(args),
  }))
}
