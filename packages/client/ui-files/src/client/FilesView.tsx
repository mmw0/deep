/**
 * Files view: the sandbox file browser tab. Shows WHERE the session's files
 * live (the workspace directory, or the storage root in chat mode), lists
 * that directory through the Host's file face, and opens text files in an
 * in-app editor that saves through the Host. HTML files get a live-preview
 * link served by the workspace preview server.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { FileContent, FileEntry, FileListing } from '@deepseek-ai/dsh-client-runtime/client'
import {
  Button, IconChevronLeftOutline14, IconCodeOutline16, IconCopyOutline16,
  IconFolderClose16, IconLinkOutline16, IconRefreshOutline16, Tooltip, writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { FilesKey } from './locales.ts'
import css from './FilesView.module.css'

/** Host actions injected by this package's apply (the workspaces service face). */
export interface FilesViewInjected {
  listFiles: (path?: string, signal?: AbortSignal) => Promise<FileListing>
  readFile: (path: string, signal?: AbortSignal) => Promise<FileContent>
  writeFile: (path: string, content: string) => Promise<{ path: string; bytes: number }>
}

/** Full view props: the conversation-view runtime share + injected actions + locale. */
export type FilesViewProps = ConvViewProps & FilesViewInjected & PropsLocale<'files'>

/** Human byte size with a binary-KB cut (matches desktop file managers). */
function sizeLabel(bytes: number, t: (key: FilesKey, params?: Record<string, unknown>) => string): string {
  if (bytes < 1024) return t('size.bytes', { n: String(bytes) })
  if (bytes < 1024 * 1024) return t('size.kb', { n: (bytes / 1024).toFixed(bytes < 10240 ? 1 : 0) })
  return t('size.mb', { n: (bytes / (1024 * 1024)).toFixed(1) })
}


function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}

function isPreviewableFile(name: string): boolean {
  const ext = extensionOf(name)
  return ext === 'html' || ext === 'htm'
}

/** Editor document state for one opened file. */
interface OpenFile {
  path: string
  name: string
  /** The durable text the editor loaded. */
  loaded: string
  /** The user's working draft (dirty when it differs from `loaded`). */
  draft: string
  saving: boolean
  saved: boolean
  error: string | null
}

export function FilesView({
  sessionId, useSessions, useWorkspaces, listFiles, readFile, writeFile, t,
}: FilesViewProps) {
  // The session's directory: its owning Workspace's path when it has one;
  // chat-mode sessions (no Workspace) browse the storage root instead.
  const cwd = useSessions(s => s.byId[sessionId]?.cwd)
  const workspaces = useWorkspaces(s => s.items)
  const owningWorkspace = useMemo(
    () => workspaces.find(workspace => cwd !== undefined && workspace.path === cwd),
    [workspaces, cwd],
  )
  const rootPath = owningWorkspace?.path
  const chatMode = owningWorkspace === undefined && cwd === undefined

  const [listing, setListing] = useState<FileListing | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [showHidden, setShowHidden] = useState(false)
  const [open, setOpen] = useState<OpenFile | null>(null)
  const listSignal = useRef<AbortController | null>(null)
  const readSignal = useRef<AbortController | null>(null)

  // The directory the browser is currently showing; undefined = the root
  // posture (the Host serves the storage root). Reset when the session's
  // root changes (switching workspace / mode).
  const [directory, setDirectory] = useState<string | undefined>(undefined)
  useEffect(() => { setDirectory(rootPath) }, [rootPath])

  const pull = useCallback(async (path: string | undefined): Promise<void> => {
    listSignal.current?.abort()
    const controller = new AbortController()
    listSignal.current = controller
    setLoading(true)
    setLoadError(null)
    try {
      const next = await listFiles(path, controller.signal)
      if (controller.signal.aborted) return
      setListing(next)
    } catch (reason: unknown) {
      if (controller.signal.aborted) return
      setListing(null)
      setLoadError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (listSignal.current === controller) {
        listSignal.current = null
        setLoading(false)
      }
    }
  }, [listFiles])

  // Initial pull + repull on directory change.
  useEffect(() => { void pull(directory) }, [directory, pull])

  // Close any open editor when the session switches.
  useEffect(() => {
    setOpen(null)
    readSignal.current?.abort()
  }, [sessionId])

  const openFile = useCallback((entry: FileEntry): void => {
    readSignal.current?.abort()
    const controller = new AbortController()
    readSignal.current = controller
    setOpen({
      path: entry.path,
      name: entry.name,
      loaded: '',
      draft: '',
      saving: false,
      saved: false,
      error: null,
    })
    readFile(entry.path, controller.signal).then(
      (content) => {
        if (controller.signal.aborted) return
        setOpen(current => current !== null && current.path === entry.path
          ? { ...current, loaded: content.content, draft: content.content, error: null }
          : current)
      },
      (reason: unknown) => {
        if (controller.signal.aborted) return
        setOpen(current => current !== null && current.path === entry.path
          ? { ...current, error: reason instanceof Error ? reason.message : String(reason) }
          : current)
      },
    )
  }, [readFile])

  const save = useCallback((): void => {
    if (open === null || open.saving) return
    setOpen({ ...open, saving: true, saved: false, error: null })
    writeFile(open.path, open.draft).then(
      () => {
        setOpen(current => current !== null && current.path === open.path
          ? { ...current, loaded: current.draft, saving: false, saved: true, error: null }
          : current)
        // A save can change the listing (new file, size change): repull.
        void pull(directory)
      },
      (reason: unknown) => {
        setOpen(current => current !== null && current.path === open.path
          ? { ...current, saving: false, saved: false, error: reason instanceof Error ? reason.message : String(reason) }
          : current)
      },
    )
  }, [directory, open, pull, writeFile])

  const [pathCopied, setPathCopied] = useState(false)
  const copyPath = useCallback((path: string): void => {
    void writeClipboard(path).then((ok) => {
      if (!ok) return
      setPathCopied(true)
      window.setTimeout(() => { setPathCopied(false) }, 1000)
    })
  }, [])

  const home = listing?.home
  const dirty = open !== null && open.draft !== open.loaded
  const visibleEntries = useMemo(() => {
    if (listing === null) return []
    return showHidden ? listing.entries : listing.entries.filter(entry => !entry.hidden)
  }, [listing, showHidden])
  const hiddenCount = listing === null ? 0 : listing.entries.length - visibleEntries.length
  const previewHref = open !== null && home !== undefined && isPreviewableFile(open.name) && open.path.startsWith(home + '/')
    ? `/preview/${open.path.slice(home.length + 1)}`
    : null

  const locationPath = directory ?? (chatMode ? '' : rootPath ?? '')

  return (
    <div className={css.root} data-files-view="">
      <div className={css.header}>
        <div className={css.location}>
          <span className={css.locationLabel}>{t('location.label')}</span>
          {chatMode
            ? (
              <div className={css.locationChat}>
                <div className={css.locationChatTitle}>{t('location.chat')}</div>
                <div className={css.locationChatHint}>{t('location.chatHint')}</div>
              </div>
            )
            : (
              <Tooltip label={pathCopied ? t('location.copied') : t('location.copy')} side="bottom" delayMs={300}>
                <button
                  type="button"
                  className={css.locationPath}
                  aria-label={t('location.copy')}
                  onClick={() => { copyPath(locationPath) }}
                >
                  <span className={css.locationPathText}>{locationPath || t('list.root')}</span>
                  <IconCopyOutline16 />
                </button>
              </Tooltip>
            )}
        </div>
        <div className={css.headerActions}>
          {hiddenCount > 0 && (
            <button
              type="button"
              className={css.hiddenToggle}
              aria-pressed={showHidden}
              onClick={() => { setShowHidden(v => !v) }}
            >
              {t('hidden.count', { n: String(hiddenCount) })}
            </button>
          )}
          <Tooltip label={t('refresh')} side="bottom" delayMs={300}>
            <button
              type="button"
              className={css.iconButton}
              aria-label={t('refresh.aria')}
              disabled={loading}
              onClick={() => { void pull(directory) }}
            >
              <IconRefreshOutline16 />
            </button>
          </Tooltip>
        </div>
      </div>

      {open === null ? (
        <div className={css.browser}>
          {listing !== null && (
            <div className={css.crumbs}>
              {listing.crumbs.map((crumb, index) => (
                <span key={crumb.path} className={css.crumbSeg}>
                  {index > 0 && <span className={css.crumbSep}>/</span>}
                  <button
                    type="button"
                    className={css.crumb}
                    disabled={crumb.path === listing.path}
                    onClick={() => { setDirectory(crumb.path === home ? rootPath ?? crumb.path : crumb.path) }}
                  >
                    {crumb.name}
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className={css.list} role="list">
            {loading && listing === null && <div className={css.status}>{t('loading')}</div>}
            {loadError !== null && <div className={css.error} role="alert">{t('error.load')} — {loadError}</div>}
            {!loading && loadError === null && listing !== null && visibleEntries.length === 0 && (
              <div className={css.status}>
                <div>{t('empty.dir')}</div>
                {chatMode && <div className={css.statusHint}>{t('empty.chat.hint')}</div>}
              </div>
            )}
            {visibleEntries.map(entry => (
              <button
                key={entry.path}
                type="button"
                role="listitem"
                className={css.row}
                aria-label={entry.isDirectory ? t('row.dir.aria', { name: entry.name }) : t('row.file.aria', { name: entry.name })}
                onClick={() => { entry.isDirectory ? setDirectory(entry.path) : openFile(entry) }}
              >
                <span className={clsx(css.rowIcon, entry.isDirectory && css.rowIconDir)}>
                  {entry.isDirectory ? <IconFolderClose16 /> : <IconCodeOutline16 />}
                </span>
                <span className={clsx(css.rowName, entry.hidden && css.rowNameHidden)}>{entry.name}</span>
                {entry.symlink && <span className={css.rowMeta}>→</span>}
                {!entry.isDirectory && <span className={css.rowSize}>{sizeLabel(entry.size, t)}</span>}
              </button>
            ))}
            {listing !== null && listing.truncated && <div className={css.truncated}>{t('truncated')}</div>}
          </div>
        </div>
      ) : (
        <div className={css.editor}>
          <div className={css.editorHeader}>
            <button
              type="button"
              className={css.backButton}
              onClick={() => {
                if (dirty && !window.confirm(t('error.unsaved'))) return
                readSignal.current?.abort()
                setOpen(null)
              }}
            >
              <IconChevronLeftOutline14 />
              <span>{t('editor.back')}</span>
            </button>
            <span className={clsx(css.editorFile, dirty && css.editorFileDirty)}>
              {open.name}
              {dirty ? ` · ${t('editor.dirty')}` : open.saved ? ` · ${t('editor.saved')}` : ''}
            </span>
            <div className={css.editorActions}>
              {previewHref !== null && (
                <Tooltip label={t('editor.preview')} side="bottom" delayMs={300}>
                  <a
                    className={css.iconButton}
                    aria-label={t('editor.preview.aria', { name: open.name })}
                    href={previewHref}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <IconLinkOutline16 />
                  </a>
                </Tooltip>
              )}
              <Button
                variant="primary"
                disabled={!dirty || open.saving}
                onClick={save}
              >
                {open.saving ? t('editor.saving') : t('editor.save')}
              </Button>
            </div>
          </div>
          <div className={css.editorPath} title={open.path}>{open.path}</div>
          {open.error !== null && <div className={css.error} role="alert">{t('error.read')} — {open.error}</div>}
          {open.loaded === '' && open.error === null
            ? <div className={css.status}>{t('loading')}</div>
            : (
              <textarea
                className={css.textarea}
                spellCheck={false}
                value={open.draft}
                onChange={(e) => {
                  setOpen({ ...open, draft: e.target.value, saved: false })
                }}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 's') {
                    e.preventDefault()
                    save()
                  }
                }}
              />
            )}
        </div>
      )}
    </div>
  )
}
