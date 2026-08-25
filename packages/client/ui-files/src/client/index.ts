/**
 * Files plugin, browser half. One registration: a `conversation.view` entry
 * (id `files`) that renders the sandbox file browser — the session's
 * workspace directory (or the storage root in chat mode) with view/edit
 * through the Host's file face.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the 'conversation.view' SlotMap row (declared by the slot's
// owning package) must be in the program for the register call to type.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { en, NS, zh } from './locales.ts'
import { FilesView, type FilesViewInjected } from './FilesView.tsx'

export type { FilesKey } from './locales.ts'
export type { FilesViewInjected, FilesViewProps } from './FilesView.tsx'
export { FilesView } from './FilesView.tsx'

/** Required services: the conversation view slot, the workspaces face, and the locale service. */
export const inject = ['slots', 'workspaces', 'locale']

/**
 * Client plugin body: register the Files view tab. The registration rides
 * the slot service's effect wrapper, so plugin unload removes the tab.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-files: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'files',
    order: 5,
    locale: NS,
    label: () => t('view.files'),
    inject: (_sessionId: SessionId): FilesViewInjected => ({
      listFiles: (path, signal) => ctx.workspaces.listFiles(path, signal),
      readFile: (path, signal) => ctx.workspaces.readFile(path, signal),
      writeFile: (path, content) => ctx.workspaces.writeFile(path, content),
    }),
  }, FilesView))
}
