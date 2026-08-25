/** WorkspaceRuntime projects the Workspace object manager for UI consumers. */

import type { Context } from '@deepseek-ai/cordis'
import type {
  DirectoryListing, FileContent, FileListing, IApiClient, RpcError,
  SessionId, WorkspaceId, WorkspaceView,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { SnapshotStore } from '../contract/store.ts'
import { createSnapshotStore } from '../contract/store.ts'
import type { SessionsPort, SessionsPortList } from '../contract/sessions-port.ts'
import type { IWorkspaces } from '../contract/workspaces.ts'
import { WorkspaceManager, type WorkspaceListPhase } from './manager.ts'

/** Workspace list plus the two-baseline readiness and default-target projection. */
export interface WorkspaceListState {
  items: readonly WorkspaceView[]
  /**
   * Registry-global archive set in Host order: grouping surfaces hide these
   * sessions everywhere (workspace groups and the ungrouped bucket) while
   * their session logs and workspace accounting slots remain. A plain array
   * (store-engine vocabulary; immer drafts reject Sets) — membership lookups
   * build their own transient Set.
   */
  archivedSessionIds: readonly SessionId[]
  state: 'idle' | 'loading' | 'error'
  phase: WorkspaceListPhase
  error: RpcError | null
  /** True only after both workspace.list and session.list have succeeded. */
  baselinesReady: boolean
  /** Most recently active Workspace, derived without changing `items` order. */
  recentWorkspaceId: WorkspaceId | undefined
}

/** Structured create failure for UI flows that distinguish Host business errors. */
export class WorkspaceCreateError extends Error {
  constructor(readonly rpcError: RpcError) {
    super(`workspace create failed: ${rpcError.code}: ${rpcError.message}`)
    this.name = 'WorkspaceCreateError'
  }
}

/** Structured browse failure so the directory browser can branch on Host business codes. */
export class DirectoryBrowseError extends Error {
  constructor(readonly rpcError: RpcError) {
    super(`directory browse failed: ${rpcError.code}: ${rpcError.message}`)
    this.name = 'DirectoryBrowseError'
  }
}

/** Real Workspace object layer and Host actions. */
export class WorkspaceRuntime implements IWorkspaces {
  /** UI-facing immutable projection; the manager remains wire truth. */
  readonly list: SnapshotStore<WorkspaceListState>
  /** Workspace baseline and frame owner. */
  private readonly manager: WorkspaceManager
  /** In-flight blank-session creates keyed by workspace (connectWorkspace coalescing). */
  private readonly connecting = new Map<WorkspaceId, Promise<SessionId>>()
  /** In-flight chat connect (connectChat coalescing). */
  private connectingChat: Promise<SessionId> | undefined
  /** Guards the runtime-owned one-shot initial-selection subscription. */
  private initialSelectionStarted = false

  /**
   * @param ctx - client root context.
   * @param api - shared wire client.
   * @param sessions - cross-domain sessions face used for recency and blank-session reuse.
   */
  constructor(ctx: Context, private readonly api: IApiClient, private readonly sessions: SessionsPort) {
    this.manager = new WorkspaceManager(api)
    this.list = createSnapshotStore<WorkspaceListState>({
      items: [], archivedSessionIds: [], state: 'idle', phase: 'pending', error: null,
      baselinesReady: false, recentWorkspaceId: undefined,
    })
    this.manager.subscribe(() => { this.project() })
    this.sessions.list.subscribe(() => { this.project() })
    ctx.reflect.provide('workspaces', this, undefined)
  }

  /**
   * Resolve the session a New Session flow lands in once this Workspace is
   * chosen: reuse the workspace's existing blank session when one is in the
   * list mirror, else create a fresh one on the host (`session.create` births
   * the full Session+Agent — the client holds no intermediate state). The
   * caller owns navigation: take the returned id to `sessions.open`.
   * Resolution guarantee (both arms): the returned id is already in the list
   * store and `sessions.binding(id)` resolves synchronously — draft hand-off
   * may write the new scope's machine before opening.
   * @param workspaceId - chosen Workspace (must be in the workspace list).
   * @returns the reused or newly created session id.
   */
  async connectWorkspace(workspaceId: WorkspaceId): Promise<SessionId> {
    const workspace = this.list.getSnapshot().items.find(item => item.workspaceId === workspaceId)
    if (workspace === undefined) throw new Error(`workspaces.connectWorkspace: unknown workspace ${workspaceId}`)
    // Coalesce concurrent connects: a create's summary lands without cwd
    // until the host frame arrives, so a second call inside that window
    // would miss the reuse scan and mint another hidden blank session.
    const inflight = this.connecting.get(workspaceId)
    if (inflight !== undefined) return inflight
    // Reuse requires workspace membership (id in sessionIds AND same
    // canonical cwd — the host's own membership rule), never cwd alone:
    // a cwd match can belong to no account (sessions the CLI/TUI birthed at
    // the host cwd, or a deleted/recreated registration) and reusing it
    // would open a session no grouping surface shows under this workspace.
    // An archived blank is never reused either: reuse would open a session
    // no grouping surface can show, so New Session mints a fresh one instead.
    const archived = this.list.getSnapshot().archivedSessionIds
    const sessions = this.sessions.list.getSnapshot()
    for (const id of sessions.ids) {
      const summary = sessions.byId[id]
      if (summary !== undefined && summary.blank && summary.cwd === workspace.path
        && workspace.sessionIds.includes(summary.id)
        && !archived.includes(summary.id)) return summary.id
    }
    const attempt = this.sessions.create({ workspaceId })
      .finally(() => { this.connecting.delete(workspaceId) })
    this.connecting.set(workspaceId, attempt)
    return attempt
  }

  /**
   * Resolve the session chat mode lands in: reuse the most recent blank
   * session that no Workspace owns (and the archive set hides), else create a
   * fresh Workspace-less session on the host — the Host's default project
   * (chat scratch directory) is its cwd. Coalesced like connectWorkspace so a
   * double click mints one session, never two.
   * @returns the reused or newly created session id.
   */
  connectChat(): Promise<SessionId> {
    const inflight = this.connectingChat
    if (inflight !== undefined) return inflight
    const attempt = (async (): Promise<SessionId> => {
      const snapshot = this.list.getSnapshot()
      const archived = snapshot.archivedSessionIds
      const owned = new Set<SessionId>(snapshot.items.flatMap(workspace => workspace.sessionIds))
      const sessions = this.sessions.list.getSnapshot()
      let reuse: SessionId | undefined
      let reuseTime = Number.NEGATIVE_INFINITY
      for (const id of sessions.ids) {
        const summary = sessions.byId[id]
        if (summary === undefined || !summary.blank || owned.has(id) || archived.includes(id)) continue
        if (summary.updatedAt >= reuseTime) {
          reuse = id
          reuseTime = summary.updatedAt
        }
      }
      if (reuse !== undefined) return reuse
      return await this.sessions.create({})
    })().finally(() => { this.connectingChat = undefined })
    this.connectingChat = attempt
    return attempt
  }

  /**
   * Follow the first complete Workspace/Session baseline and select a default
   * session exactly once. A restored current session wins; otherwise chat
   * mode is the default posture — its blank session is connected (reused or
   * created). Later explicit clears stay cleared instead of retriggering this
   * startup policy. A failed connect may retry on the next baseline projection.
   * @returns disposer for the baseline subscription; late work cannot navigate after disposal.
   */
  startInitialSelection(): () => void {
    if (this.initialSelectionStarted) {
      throw new Error('workspaces.startInitialSelection: already started')
    }
    this.initialSelectionStarted = true
    let state: 'waiting' | 'connecting' | 'done' = 'waiting'
    let disposed = false
    const reconcile = (): void => {
      if (disposed || state !== 'waiting') return
      const workspace = this.list.getSnapshot()
      if (!workspace.baselinesReady) return
      const current = this.sessions.list.getSnapshot().current
      if (current !== undefined) {
        state = 'done'
        return
      }
      state = 'connecting'
      void this.connectChat().then(
        (sessionId) => {
          if (disposed) return
          if (this.sessions.list.getSnapshot().current === undefined) {
            this.sessions.open(sessionId)
          }
          state = 'done'
        },
        (reason: unknown) => {
          if (disposed) return
          state = 'waiting'
          console.warn('initial chat selection failed:', reason)
        },
      )
    }
    const unsubscribe = this.list.subscribe(reconcile)
    reconcile()
    return () => {
      disposed = true
      unsubscribe()
    }
  }

  /**
   * The shared New Session action behind the shell entry points (sidebar
   * button, workspace browser): resolve the target Workspace — explicit wins,
   * then the current Session's Workspace — connect its blank session and
   * navigate there; with no Workspace at all, chat mode is the default: its
   * blank session is connected and opened (never the inert picker-only New
   * Session view). Connect failures are non-fatal (console diagnostics; the
   * current view stays usable).
   * @param workspaceId - explicit target Workspace for scoped actions.
   */
  startSession(workspaceId?: WorkspaceId): void {
    const workspace = this.list.getSnapshot()
    const current = this.sessions.list.getSnapshot().current
    const currentWorkspaceId = current === undefined
      ? undefined
      : workspace.items.find(item => item.sessionIds.includes(current))?.workspaceId
    const target = workspaceId ?? currentWorkspaceId
    if (target === undefined) {
      void this.connectChat().then(
        (sessionId) => { this.sessions.open(sessionId) },
        (reason: unknown) => { console.warn('new chat session failed:', reason) },
      )
      return
    }
    void this.connectWorkspace(target).then(
      (sessionId) => { this.sessions.open(sessionId) },
      (reason: unknown) => { console.warn('new session failed:', reason) },
    )
  }

  /**
   * Register an existing path as a Workspace.
   * @param input - the Host create payload.
   * @returns the created or idempotently resolved Workspace.
   */
  async create(input: { path: string }): Promise<WorkspaceView> {
    const result = await this.manager.create(input)
    if (!result.ok) throw new WorkspaceCreateError(result.error)
    return result.value.workspace
  }

  /**
   * Open the Host's native directory picker (the `native` capability).
   * @returns the selected path, or null when the user cancelled.
   */
  async pickDirectory(): Promise<string | null> {
    const response = await this.api.host.pickDirectory({})
    if (!response.result.ok) {
      throw new Error(`directory picker failed: ${response.result.error.message}`)
    }
    return response.result.value.path
  }

  /**
   * List one directory level through the Host's `browse` capability.
   * @param path - absolute directory to list; absent lists the Host home directory.
   * @param signal - aborts the wire request (and the Host's scan) when the caller supersedes it.
   * @returns the level's listing with breadcrumb ancestry.
   */
  async listDirectory(path?: string, signal?: AbortSignal): Promise<DirectoryListing> {
    const response = await this.api.host.listDirectory(path === undefined ? {} : { path }, signal)
    if (!response.result.ok) throw new DirectoryBrowseError(response.result.error)
    return response.result.value
  }

  /**
   * Create one child directory through the Host's `browse` capability.
   * @param path - absolute existing parent directory.
   * @param name - single non-blank path segment.
   * @returns the created directory's absolute path.
   */
  async createDirectory(path: string, name: string): Promise<string> {
    const response = await this.api.host.createDirectory({ path, name })
    if (!response.result.ok) throw new DirectoryBrowseError(response.result.error)
    return response.result.value.path
  }

  /**
   * Open a filesystem path with the Host operating system's default application.
   * @param path - absolute or host-resolvable path.
   */
  async openPath(path: string): Promise<void> {
    const response = await this.api.host.openPath({ path })
    if (!response.result.ok) {
      throw new Error(`path open failed: ${response.result.error.message}`)
    }
  }

  /**
   * Rename a Workspace.
   * @param workspaceId - target workspace.
   * @param title - new display title (trimmed non-empty by the Host).
   * @returns the renamed Workspace view.
   */
  async rename(workspaceId: WorkspaceId, title: string): Promise<WorkspaceView> {
    const result = await this.manager.rename(workspaceId, title)
    if (!result.ok) throw new Error(`workspace rename failed: ${result.error.code}: ${result.error.message}`)
    return result.value.workspace
  }

  /**
   * Delete one Workspace registration (this deployment's delete also wipes the
   * workspace folder and its session logs host-side). When the deleted
   * Workspace owned the current session, chat mode takes over so the user
   * always lands on a usable input instead of a dead selection.
   * @param workspaceId - target workspace.
   */
  async delete(workspaceId: WorkspaceId): Promise<void> {
    const ownedCurrent = this.sessions.list.getSnapshot().current
    const workspace = this.list.getSnapshot().items.find(item => item.workspaceId === workspaceId)
    const hadCurrent = workspace !== undefined && ownedCurrent !== undefined
      && workspace.sessionIds.includes(ownedCurrent)
    const result = await this.manager.delete(workspaceId)
    if (!result.ok) throw new Error(`workspace delete failed: ${result.error.code}: ${result.error.message}`)
    // The Host wiped the workspace's sessions along with its folder; re-pull
    // the Session baseline so their rows leave every grouping surface now,
    // not on the next reconnect.
    void this.sessions.refresh?.().catch(() => {})
    if (hadCurrent) {
      void this.connectChat().then(
        (sessionId) => { this.sessions.open(sessionId) },
        (reason: unknown) => { console.warn('post-delete chat landing failed:', reason) },
      )
    }
  }

  /**
   * Move a Workspace within the durable registry display order.
   * @param workspaceId - Workspace to move.
   * @param beforeWorkspaceId - Anchor workspace; omitted appends.
   */
  async insertBefore(workspaceId: WorkspaceId, beforeWorkspaceId?: WorkspaceId): Promise<void> {
    const result = await this.manager.insertBefore(workspaceId, beforeWorkspaceId)
    if (!result.ok) throw new Error(`workspace reorder failed: ${result.error.code}: ${result.error.message}`)
  }

  /**
   * Archive a session into the registry-global set. Clearing an archived
   * current selection is the projection sweep's job (one rule for the local
   * echo and a remote tab's frame alike).
   * @param sessionId - session to archive.
   */
  async archiveSession(sessionId: SessionId): Promise<void> {
    const result = await this.manager.archiveSession(sessionId)
    if (!result.ok) throw new Error(`session archive failed: ${result.error.code}: ${result.error.message}`)
  }

  /**
   * Permanently delete one session: the Host wipes its durable log and
   * disposes the live session, so the row leaves every grouping surface
   * through `host/session-removed`. When the deleted session is the current
   * selection, chat mode takes over so the user always lands on a usable
   * input instead of a dead selection.
   * @param sessionId - session to delete.
   */
  async deleteSession(sessionId: SessionId): Promise<void> {
    const current = this.sessions.list.getSnapshot().current
    const wasCurrent = current === sessionId
    const result = await this.manager.deleteSession(sessionId)
    if (!result.ok) throw new Error(`session delete failed: ${result.error.code}: ${result.error.message}`)
    // Belt-and-braces baseline re-pull: the host frame usually lands first,
    // but a slow or dropped stream must not leave a ghost row until the next
    // reconnect.
    void this.sessions.refresh?.().catch(() => {})
    if (wasCurrent) {
      void this.connectChat().then(
        (chatSessionId) => { this.sessions.open(chatSessionId) },
        (reason: unknown) => { console.warn('post-delete chat landing failed:', reason) },
      )
    }
  }

  /**
   * List one directory level of files AND directories through the Host's
   * file browser face.
   * @param path - absolute directory to list; absent lists the storage root.
   * @param signal - aborts the wire request when the caller supersedes it.
   * @returns the level's listing with breadcrumb ancestry.
   */
  async listFiles(path?: string, signal?: AbortSignal): Promise<FileListing> {
    const response = await this.api.host.listFiles(path === undefined ? {} : { path }, signal)
    if (!response.result.ok) throw new DirectoryBrowseError(response.result.error)
    return response.result.value
  }

  /**
   * Read one UTF-8 text file for the in-app viewer/editor.
   * @param path - absolute file path.
   * @param signal - aborts the wire request when the caller supersedes it.
   * @returns the file's decoded text.
   */
  async readFile(path: string, signal?: AbortSignal): Promise<FileContent> {
    const response = await this.api.host.readFile({ path }, signal)
    if (!response.result.ok) throw new DirectoryBrowseError(response.result.error)
    return response.result.value
  }

  /**
   * Write one UTF-8 text file (create or overwrite) through the Host.
   * @param path - absolute file path.
   * @param content - the full new file text.
   * @returns the durable path and its byte length.
   */
  async writeFile(path: string, content: string): Promise<{ path: string; bytes: number }> {
    const response = await this.api.host.writeFile({ path, content })
    if (!response.result.ok) throw new DirectoryBrowseError(response.result.error)
    return response.result.value
  }

  /**
   * Move a session within its Workspace's manual order (DOM-insertBefore-like).
   * @param workspaceId - owning workspace.
   * @param sessionId - accounted session to move.
   * @param beforeSessionId - accounted anchor to insert before; omitted appends.
   * @returns the updated Workspace view.
   */
  async insertSessionBefore(
    workspaceId: WorkspaceId,
    sessionId: SessionId,
    beforeSessionId?: SessionId,
  ): Promise<WorkspaceView> {
    const result = await this.manager.insertSessionBefore(workspaceId, sessionId, beforeSessionId)
    if (!result.ok) throw new Error(`workspace move failed: ${result.error.code}: ${result.error.message}`)
    return result.value.workspace
  }

  /**
   * Refresh the workspace baseline, reusing an in-flight pull.
   * @returns completion of the current or newly started workspace baseline pull.
   */
  refresh(): Promise<void> {
    return this.manager.refresh()
  }

  /**
   * Route a Host stream envelope into the Workspace object layer.
   * @param envelope - validated Host stream envelope.
   */
  handleHostEnvelope(envelope: Parameters<WorkspaceManager['handleHostEnvelope']>[0]): void {
    this.manager.handleHostEnvelope(envelope)
  }

  /** Rebuild the Workspace baseline after connection. */
  handleConnected(): void {
    this.manager.handleConnected()
  }

  private project(): void {
    const workspace = this.manager.getSnapshot()
    const sessions = this.sessions.list.getSnapshot()
    const baselinesReady = workspace.phase === 'ready' && sessions.phase === 'ready'
    // An archived current selection clears into a fresh chat session —
    // a hidden row must not stay open behind the list, and the beginner
    // posture is always a ready chat input. Sweeping here covers every
    // install path with one rule: the local unary echo, another tab's
    // changed frame, and a reconnect baseline restoring a persisted
    // selection that was archived while this client was away.
    if (sessions.current !== undefined && workspace.archivedSessionIds.includes(sessions.current)) {
      this.sessions.clear()
      void this.connectChat().then(
        (sessionId) => { this.sessions.open(sessionId) },
        (reason: unknown) => { console.warn('post-archive chat landing failed:', reason) },
      )
    }
    this.list.set({
      items: workspace.items,
      archivedSessionIds: workspace.archivedSessionIds,
      state: workspace.state,
      phase: workspace.phase,
      error: workspace.error,
      baselinesReady,
      recentWorkspaceId: baselinesReady ? recentWorkspace(workspace.items, sessions.byId) : undefined,
    })
  }
}

/** Stable tie-breaking follows Host Workspace order. */
function recentWorkspace(
  workspaces: readonly WorkspaceView[],
  sessions: SessionsPortList['byId'],
): WorkspaceId | undefined {
  let selected: WorkspaceId | undefined
  let selectedTime = Number.NEGATIVE_INFINITY
  for (const workspace of workspaces) {
    let latest = Number.NEGATIVE_INFINITY
    for (const sessionId of workspace.sessionIds) {
      const session = sessions[sessionId]
      if (session !== undefined) latest = Math.max(latest, session.updatedAt)
    }
    if (latest === Number.NEGATIVE_INFINITY) latest = Date.parse(workspace.createdAt)
    if (selected === undefined || latest > selectedTime) {
      selected = workspace.workspaceId
      selectedTime = latest
    }
  }
  return selected
}
