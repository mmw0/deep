/** `files` namespace dictionaries: the Files view tab (location, browser, editor). */

/** Dictionary namespace owned by this plugin. */
export const NS = 'files'

/** The files dictionary key set (the source of truth for both locales). */
export type FilesKey =
  | 'view.files'
  | 'location.label'
  | 'location.chat'
  | 'location.chatHint'
  | 'location.copy'
  | 'location.copied'
  | 'refresh'
  | 'refresh.aria'
  | 'up'
  | 'up.aria'
  | 'list.root'
  | 'empty.dir'
  | 'empty.chat'
  | 'empty.chat.hint'
  | 'loading'
  | 'error.load'
  | 'error.read'
  | 'error.save'
  | 'error.unsaved'
  | 'row.file.aria'
  | 'row.dir.aria'
  | 'size.bytes'
  | 'size.kb'
  | 'size.mb'
  | 'editor.back'
  | 'editor.edit'
  | 'editor.readonly'
  | 'editor.save'
  | 'editor.saving'
  | 'editor.saved'
  | 'editor.dirty'
  | 'editor.preview'
  | 'editor.preview.aria'
  | 'editor.download'
  | 'editor.download.aria'
  | 'editor.path'
  | 'hidden.count'
  | 'truncated'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Files view tab: sandbox location, browser rows, and the editor. */
    'files': FilesKey
  }
}

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'view.files': '文件',
  'location.label': '文件位置',
  'location.chat': '聊天模式不创建文件',
  'location.chatHint': '智能体在“工作区（NIXE）”模式下创建的文件会保存在这里。',
  'location.copy': '复制路径',
  'location.copied': '已复制',
  'refresh': '刷新',
  'refresh.aria': '刷新文件列表',
  'up': '上一级',
  'up.aria': '打开上一级目录',
  'list.root': '沙箱根目录',
  'empty.dir': '此文件夹为空',
  'empty.chat': '这里还没有文件',
  'empty.chat.hint': '让智能体在工作区里创建文件，它们会出现在这里。',
  'loading': '正在加载文件…',
  'error.load': '无法读取此文件夹',
  'error.read': '无法打开此文件',
  'error.save': '保存失败',
  'error.unsaved': '有未保存的修改',
  'row.file.aria': '打开文件 {name}',
  'row.dir.aria': '打开文件夹 {name}',
  'size.bytes': '{n} B',
  'size.kb': '{n} KB',
  'size.mb': '{n} MB',
  'editor.back': '返回文件列表',
  'editor.edit': '编辑',
  'editor.readonly': '只读',
  'editor.save': '保存',
  'editor.saving': '正在保存…',
  'editor.saved': '已保存',
  'editor.dirty': '未保存',
  'editor.preview': '预览',
  'editor.preview.aria': '在新标签页预览 {name}',
  'editor.download': '下载',
  'editor.download.aria': '下载 {name}',
  'editor.path': '路径',
  'hidden.count': '{n} 个隐藏项',
  'truncated': '文件过多，仅显示前一部分',
} satisfies Record<FilesKey, string>

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'view.files': 'Files',
  'location.label': 'Files are saved at',
  'location.chat': 'Chat mode creates no files',
  'location.chatHint': 'Files the agent creates in a workspace (NIXE) are saved here.',
  'location.copy': 'Copy path',
  'location.copied': 'Copied',
  'refresh': 'Refresh',
  'refresh.aria': 'Refresh file list',
  'up': 'Parent folder',
  'up.aria': 'Open the parent folder',
  'list.root': 'Sandbox',
  'empty.dir': 'This folder is empty',
  'empty.chat': 'No files here yet',
  'empty.chat.hint': 'Ask the agent to create files in a workspace — they will appear here.',
  'loading': 'Loading files…',
  'error.load': 'Could not read this folder',
  'error.read': 'Could not open this file',
  'error.save': 'Save failed',
  'error.unsaved': 'You have unsaved changes',
  'row.file.aria': 'Open file {name}',
  'row.dir.aria': 'Open folder {name}',
  'size.bytes': '{n} B',
  'size.kb': '{n} KB',
  'size.mb': '{n} MB',
  'editor.back': 'Back to files',
  'editor.edit': 'Edit',
  'editor.readonly': 'Read-only',
  'editor.save': 'Save',
  'editor.saving': 'Saving…',
  'editor.saved': 'Saved',
  'editor.dirty': 'Unsaved',
  'editor.preview': 'Preview',
  'editor.preview.aria': 'Preview {name} in a new tab',
  'editor.download': 'Download',
  'editor.download.aria': 'Download {name}',
  'editor.path': 'Path',
  'hidden.count': '{n} hidden',
  'truncated': 'Many files — showing the first ones',
} satisfies Record<FilesKey, string>
