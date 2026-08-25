/**
 * host domain contract. No protocol version: client and host ship
 * together; introduce protocolVersion only when an independently released client appears.
 */

import type { RpcRequest, RpcResponse } from './rpc.ts'

/** One directory row of a listing: a child entry or a breadcrumb ancestor. */
export interface DirectoryEntry {
  /** Base name shown in a browser row (a root crumb carries its full path). */
  name: string
  /** Absolute host path — the client never joins path segments itself. */
  path: string
  /** Hidden by the host platform's convention (dot-prefixed on POSIX); the client owns whether to show it. */
  hidden: boolean
}

/** One file-or-directory row of a workspace file listing. */
export interface FileEntry {
  /** Base name shown in a browser row. */
  name: string
  /** Absolute host path — the client never joins path segments itself. */
  path: string
  /** Directory rows open on click; file rows open the viewer. */
  isDirectory: boolean
  /** File size in bytes; 0 for directories. */
  size: number
  /** Hidden by the host platform's convention (dot-prefixed on POSIX). */
  hidden: boolean
  /** Symlink rows (resolved kind reported by the host). */
  symlink: boolean
}

/** host.listDirectory response value: one directory level plus its ancestry. */
export interface DirectoryListing {
  /** Absolute path of the listed directory. */
  path: string
  /** The host account's home directory (breadcrumb "Home" rooting). */
  home: string
  /**
   * Ancestor chain from the filesystem root to the listed directory
   * inclusive; every crumb is a jump target (crumb `hidden` is always false).
   */
  crumbs: DirectoryEntry[]
  /** Direct child directories, name-sorted; symlinks to directories included. */
  entries: DirectoryEntry[]
  /** True when the backend cut `entries` at its complete-result bound (the name-sorted tail is absent). */
  truncated: boolean
}

/** host.listFiles response value: one level of directories plus files with sizes. */
export interface FileListing {
  /** Absolute path of the listed directory. */
  path: string
  /** The host account's home directory (breadcrumb "Home" rooting). */
  home: string
  /** Ancestor chain from the filesystem root to the listed directory inclusive. */
  crumbs: DirectoryEntry[]
  /** Direct children — directories first, then files, each name-sorted. */
  entries: FileEntry[]
  /** True when the listing was cut at its complete-result bound. */
  truncated: boolean
}

/** host.readFile response value: one file's UTF-8 text. */
export interface FileContent {
  /** Absolute path of the read file. */
  path: string
  /** The file's decoded UTF-8 text. */
  content: string
  /** File size in bytes. */
  size: number
}

/** Host-level unary methods. */
export interface HostApi {
  /**
   * One-shot host snapshot. Empty payload uses the literal `{}` (extend in place when fields arrive).
   * version = the host app's (apps/cli) package.json version; cwd = the host process working
   * directory (root for session persistence and tool execution); provider/model = the defaults
   * applied when a new agent doesn't specify them explicitly, absent when the host configures
   * no explicit default (the adapter falls back internally);
   * attachedSessions = count of currently attached sessions (those with a live agent);
   * home = the host account home directory (Web display abbreviation on POSIX);
   * canOpenPath = whether this deployment can hand a path to a user-visible native desktop.
   */
  describe(request: RpcRequest<{}>): Promise<RpcResponse<{
    version: string
    cwd: string
    provider?: string
    model?: string
    attachedSessions: number
    home: string
    canOpenPath: boolean
  }>>

  /**
   * Open the operating system's single-directory picker; cancellation returns
   * null. Only served under the `native` capability.
   */
  pickDirectory(
    request: RpcRequest<{}>,
    signal: AbortSignal,
  ): Promise<RpcResponse<{ path: string | null }>>

  /**
   * List one directory level for the in-app browser; an absent path lists the
   * host account's home directory. Only served under the `browse` capability;
   * unreadable or missing targets fail with `directory-unreadable`. The
   * carrier's request signal follows the caller, stopping the backend's scan
   * on disconnect or timeout.
   */
  listDirectory(
    request: RpcRequest<{ path?: string }>,
    signal: AbortSignal,
  ): Promise<RpcResponse<DirectoryListing>>

  /**
   * Create one child directory under an existing parent (the browser's
   * "New folder"). Only served under the `browse` capability; an existing
   * child fails with `directory-exists`, every other filesystem failure with
   * `directory-create-failed`.
   */
  createDirectory(
    request: RpcRequest<{ path: string; name: string }>,
  ): Promise<RpcResponse<{ path: string }>>

  /**
   * Open a filesystem path with the operating system's default application
   * (Finder / Explorer / xdg-open hand-off). The browser carrier's
   * prefix-wide trust fence covers this privileged method like every other
   * `/api` request.
   */
  openPath(
    request: RpcRequest<{ path: string }>,
    signal: AbortSignal,
  ): Promise<RpcResponse<{ opened: true }>>

  /**
   * List one directory level for the in-app file browser: direct child
   * DIRECTORIES and FILES with sizes, name-sorted (directories first).
   * Absent path lists the host home directory. Fails with
   * `directory-unreadable` for a missing or unreadable target, and with
   * `path-not-file` when the target is not a directory.
   */
  listFiles(
    request: RpcRequest<{ path?: string }>,
    signal: AbortSignal,
  ): Promise<RpcResponse<FileListing>>

  /**
   * Read one UTF-8 text file for the in-app viewer/editor. Fails with
   * `file-not-found`, with `file-too-large` beyond the read cap, or with
   * `file-binary` when the content is not decodable text (a NUL byte in the
   * probe window).
   */
  readFile(
    request: RpcRequest<{ path: string }>,
    signal: AbortSignal,
  ): Promise<RpcResponse<FileContent>>

  /**
   * Write one UTF-8 text file (create or overwrite). Parent directories are
   * created as needed so a freshly typed path materializes in one gesture.
   * Fails with `file-write-failed` on filesystem rejection.
   */
  writeFile(
    request: RpcRequest<{ path: string; content: string }>,
  ): Promise<RpcResponse<{ path: string; bytes: number }>>
}
