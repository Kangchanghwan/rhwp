/**
 * cbEdit v1 의 studio 쪽 낮은 층. `?embed=cs` 일 때만 켜지고 `window.rhwpStudio.cs` 에 붙는다.
 * 부모(Clipboard Share)와 postMessage 로 대화하는 쪽은 cs/agent/editBridge.js 이고, 그 쪽이 이 객체만 부른다.
 *
 *  - isCsEmbed(search): 주소가 `?embed=cs` 인지
 *  - csEmbedFileCommands(cmds, onSaveRequest): 파일 메뉴 정리. 저장 계열은 내려받기 대신 saveRequest 로,
 *    문서를 바꾸는 열기·새 문서·최근 문서는 뺀다(문서는 부모가 open 으로만 바꾼다)
 *  - installCsEmbedHost(deps): window.rhwpStudio.cs 설치, ?theme= 반영, Ctrl/Cmd+S 의 브라우저 저장 막기
 */
import type { CommandDef } from '../../rhwp-studio/src/command/types';
import { setThemeMode, getEffectiveTheme } from '../../rhwp-studio/src/core/theme';

export function isCsEmbed(search: string): boolean {
  return new URLSearchParams(search).get('embed') === 'cs';
}

/** 문서를 바꾸는 파일 메뉴 항목 (embed 프로파일의 EMBED_HIDDEN_FILE_COMMAND_IDS 중 열기 계열) */
const REPLACE_IDS = ['file:new-doc', 'file:open', 'file:open-recent', 'file:clear-recent'];

export function csEmbedFileCommands(cmds: readonly CommandDef[], onSaveRequest: () => void): CommandDef[] {
  return cmds
    .filter((c) => !REPLACE_IDS.includes(c.id))
    .map((c) => (c.id.startsWith('file:save') ? { ...c, execute: () => { onSaveRequest(); } } : c));
}

/** 문서 교체 진입점(열기·새 문서·최근 문서·문서 비교)의 메뉴·툴바 항목을 지운다 (main.ts pruneEmbedChrome 과 같은 정리) */
export function csPruneEmbedChrome(): void {
  for (const id of [...REPLACE_IDS, 'edit:compare-documents']) {
    document.querySelectorAll(`[data-cmd="${id}"]`).forEach((item) => item.remove());
  }
  const dropdown = document.querySelector('.menu-item[data-menu="file"] .menu-dropdown');
  if (!dropdown) return;
  dropdown.querySelectorAll('.md-sub[data-recent]').forEach((sub) => sub.remove());
  dropdown.querySelectorAll('.md-sep').forEach((sep) => {
    const prev = sep.previousElementSibling;
    if (!prev || prev.classList.contains('md-sep')) sep.remove();
  });
  const last = dropdown.lastElementChild;
  if (last?.classList.contains('md-sep')) last.remove();
}

interface Bus {
  on(event: string, handler: (...args: any[]) => void): () => void;
  emit(event: string, ...args: unknown[]): void;
}
interface Deps {
  eventBus: Bus;
  documentState: { isDirty(): boolean };
  wasm: {
    pageCount: number;
    fileName: string;
    getSourceFormat(): string;
    exportHwp(): Uint8Array;
    exportHwpx(): Uint8Array;
  };
  ready: Promise<unknown>;
  /** 내장 플러그인 로드 (cbHwpAgent 에이전트가 쓰는 hwpctrl). iframe 의 부모가 RPC 로 올려 주지 않아도 에이전트가 동작하게 한다 */
  loadPlugin(id: string): Promise<unknown>;
  openBytes(data: Uint8Array, fileName: string): Promise<void>;
  isOpening(): boolean;
  markSaved(): Promise<unknown>;
  getCommandStatus(): { status?: string } | null;
}

export type CsEmbedEvent =
  | { event: 'dirty'; dirty: boolean }
  | { event: 'saveRequest' }
  | { event: 'error'; code: string; message: string };

export const CS_SAVE_REQUEST = 'cs-save-request';

export function installCsEmbedHost(deps: Deps): void {
  const { eventBus, documentState, wasm } = deps;
  const listeners = new Set<(e: CsEmbedEvent) => void>();
  const fire = (e: CsEmbedEvent) => { for (const l of [...listeners]) { try { l(e); } catch { /* 듣는 쪽 오류는 무시 */ } } };

  eventBus.on('document-dirty-changed', (p: { dirty: boolean }) => fire({ event: 'dirty', dirty: !!p?.dirty }));
  eventBus.on(CS_SAVE_REQUEST, () => fire({ event: 'saveRequest' }));
  eventBus.on('command-error', (p: { code?: string; recovery?: string; operation?: string }) => {
    // 복구에 실패했거나 알 수 없으면 그 문서 세션은 더 편집할 수 없다 (명령 오류 경계가 'blocked' 로 잠근다)
    if (p?.recovery === 'succeeded' && deps.getCommandStatus()?.status !== 'blocked') return;
    fire({ event: 'error', code: p?.code ?? 'ENGINE_BLOCKED', message: `편집 명령을 완료하지 못했고 복구하지 못했습니다 (${p?.operation ?? '?'}, ${p?.recovery ?? '?'})` });
  });

  const srcExt = (): 'hwp' | 'hwpx' | null => {
    if (!(wasm.pageCount > 0)) return null;
    return wasm.getSourceFormat() === 'hwpx' ? 'hwpx' : 'hwp';
  };

  // 저장 단축키는 문서가 열리기 전에도 브라우저 저장 대화상자로 새지 않게 한다
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && ['s', 'ㄴ'].includes(e.key.toLowerCase())) e.preventDefault();
  }, true);

  const theme = new URLSearchParams(window.location.search).get('theme');
  if (theme === 'light' || theme === 'dark') setThemeMode(theme);

  const cs = {
    ready: deps.ready.then(() => deps.loadPlugin('hwpctrl')).then(() => true, (e) => { console.warn('[cs-embed] hwpctrl 로드 실패', e); return true; }),
    on(cb: (e: CsEmbedEvent) => void) { listeners.add(cb); return () => { listeners.delete(cb); }; },
    async open(name: string, data: Uint8Array) {
      if (deps.isOpening()) throw new Error('문서를 여는 중입니다');
      await cs.ready;
      await deps.openBytes(data, name);
      return { pages: wasm.pageCount };
    },
    exportDocument(format?: 'hwp' | 'hwpx') {
      const ext = format ?? srcExt();
      if (!ext) throw new Error('문서가 로드되지 않았습니다');
      const bytes = ext === 'hwpx' ? wasm.exportHwpx() : wasm.exportHwp();
      return { bytes, ext };
    },
    markSaved: () => deps.markSaved(),
    state() {
      const ext = srcExt();
      return { loaded: ext !== null, dirty: documentState.isDirty(), name: ext ? wasm.fileName : null, ext };
    },
    setTheme(t: 'light' | 'dark') { setThemeMode(t); return getEffectiveTheme(); },
  };
  const w = window as unknown as { rhwpStudio?: Record<string, unknown> };
  if (w.rhwpStudio) w.rhwpStudio.cs = cs;
  else w.rhwpStudio = { cs };
}
