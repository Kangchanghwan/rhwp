/**
 * `window.rhwpStudio.csAgentTools` 와 짧은 별칭 `window.hwpAgent` — 같은 페이지 JS 용 게으른 진입점.
 * 처음 부를 때 플러그인을 올린다(코드가 작아 시작 번들에 정적으로 들어가지만, 도구 코드는 플러그인 청크라 부르기 전엔 로드되지 않는다).
 *
 *   await hwpAgent.help()                                  // 사용 설명서(한국어 + 핵심 영어)
 *   await hwpAgent.listTools()
 *   await hwpAgent.callTool('replace_text', { find, replace })  // -> {ok,result}|{ok:false,error:{code,message}}
 *   await hwpAgent.callTool('replace_text', args, { dryRun: true })   // 바뀔 내용만 보고(문서 변경 0)
 *   await hwpAgent.undo() / redo() / exportDocument('hwpx'|'hwp') / loadDocument(bytes, name)
 *
 * 시작 때 하는 일(플러그인을 올리지 않는다): <meta name="ai-agent-api"> 삽입, 메뉴 바 오른쪽에 「AI에게 맡기기」 복사 버튼 삽입.
 * WebMCP(`document.modelContext.registerTool`)가 있는 브라우저에서만 한가한 때 플러그인을 올려 도구를 등록한다.
 */
const ID = 'cs-agent-tools';

interface Registry {
  load(id: string): Promise<unknown>;
  invoke(id: string, method: string, args: unknown[]): unknown;
}

interface ToolListing { name: string; description: string; inputSchema: Record<string, unknown> }
interface ModelContextLike { registerTool?: (tool: Record<string, unknown>) => unknown }

export const META_NAME = 'ai-agent-api';
export const META_CONTENT = 'window.hwpAgent — call await hwpAgent.help()';

/** 「AI에게 맡기기」 버튼이 클립보드에 넣는 말(hwpAgent.agentPrompt 로도 읽는다). */
export const AGENT_PROMPT = '이 탭(편집기)의 문서는 페이지 안 함수로 고칠 수 있어. 화면을 클릭하지 말고 JavaScript로 `await window.hwpAgent.help()`를 먼저 실행해 사용법을 읽은 뒤, 읽기 함수로 내용을 확인하고 `run_plan`으로 한 번에 고쳐. 찾을 문구는 읽은 결과에서 그대로 복사해. 끝나면 바뀐 부분을 다시 읽어 확인해.';

export const HAND_OFF_BUTTON_ID = 'cs-ai-handoff';
const HAND_OFF_STYLE_ID = 'cs-ai-handoff-style';
const FEEDBACK_MS = 1800;

/** 클립보드 복사. navigator.clipboard 가 없거나 거절되면 숨은 textarea + execCommand 로 물러난다. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* 아래 대체 경로 */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

/** Clipboard Share 수정 화면(?embed=cs)에서는 편집만 제공하므로 복사 버튼을 달지 않는다 */
export function shouldShowHandOff(search: string): boolean {
  return new URLSearchParams(search).get('embed') !== 'cs';
}

/** 메뉴 바 오른쪽(기본 도구 상자 접기 버튼 앞)에 작은 복사 버튼을 넣는다. 기존 메뉴 색·글꼴 토큰을 그대로 쓴다. */
function installHandOffButton(): void {
  const mount = () => {
    const bar = document.getElementById('menu-bar');
    if (!bar || document.getElementById(HAND_OFF_BUTTON_ID)) return !!bar;
    if (!document.getElementById(HAND_OFF_STYLE_ID)) {
      const st = document.createElement('style');
      st.id = HAND_OFF_STYLE_ID;
      st.textContent = `
#${HAND_OFF_BUTTON_ID}{position:relative;flex:0 0 auto;margin-left:auto;margin-right:6px;padding:0 10px;height:22px;border:1px solid var(--ui-border-light,transparent);border-radius:var(--radius-sm,3px);background:transparent;color:var(--color-text-muted,#555);font:inherit;font-size:inherit;line-height:20px;white-space:nowrap;cursor:pointer;user-select:none}
#${HAND_OFF_BUTTON_ID}:hover,#${HAND_OFF_BUTTON_ID}:focus-visible{border-color:var(--accent-hover,#888);background:var(--ui-accent-bg,#eef);color:var(--color-primary-dark,#123);outline:none}
#${HAND_OFF_BUTTON_ID} .cs-short{display:none}
#${HAND_OFF_BUTTON_ID} + #toolbox-basic-toggle{margin-left:0}
#${HAND_OFF_BUTTON_ID} .cs-toast{position:absolute;top:calc(100% + 2px);right:0;z-index:1002;padding:3px 10px;border:1px solid var(--ui-border,#ccc);border-radius:var(--radius-sm,3px);background:var(--color-surface,#fff);color:var(--color-text,#222);box-shadow:var(--shadow-dropdown,0 2px 6px rgba(0,0,0,.2));pointer-events:none}
@media (max-width:479px){#${HAND_OFF_BUTTON_ID} .cs-long{display:none}#${HAND_OFF_BUTTON_ID} .cs-short{display:inline}#${HAND_OFF_BUTTON_ID}{padding:0 6px}}`;
      document.head.append(st);
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = HAND_OFF_BUTTON_ID;
    btn.title = 'AI 에이전트에게 이 문서를 맡길 때 붙여 넣을 안내문을 복사합니다';
    btn.setAttribute('aria-label', 'AI에게 맡기기: 안내문 복사');
    const long = document.createElement('span'); long.className = 'cs-long'; long.textContent = 'AI에게 맡기기';
    const short = document.createElement('span'); short.className = 'cs-short'; short.textContent = 'AI';
    btn.append(long, short);
    let timer: number | undefined;
    btn.addEventListener('click', async () => {
      const ok = await copyText(AGENT_PROMPT);
      btn.querySelector('.cs-toast')?.remove();
      const toast = document.createElement('span');
      toast.className = 'cs-toast';
      toast.setAttribute('role', 'status');
      toast.textContent = ok ? '복사했어요' : '복사하지 못했어요. 직접 복사해 주세요';
      btn.append(toast);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => toast.remove(), FEEDBACK_MS);
    });
    const toggle = bar.querySelector('#toolbox-basic-toggle');
    if (toggle) bar.insertBefore(btn, toggle); else bar.append(btn);
    return true;
  };
  try {
    if (typeof document === 'undefined') return;
    if (!mount()) document.addEventListener('DOMContentLoaded', () => { try { mount(); } catch { /* noop */ } }, { once: true });
  } catch { /* 화면이 없는 환경 */ }
}

/** 값이 직렬화 가능한 평범한 객체/배열이 되도록 복사(WebMCP 로 넘기기 전) */
const plain = <T,>(v: T): T => JSON.parse(JSON.stringify(v ?? null)) as T;

export function installCsAgentToolsGlobal(plugins: Registry, target: Record<string, unknown>): void {
  let ready: Promise<unknown> | null = null;
  const call = async (method: string, args: unknown[]) => {
    ready ??= plugins.load(ID).catch((e) => { ready = null; throw e; });
    await ready;
    return plugins.invoke(ID, method, args);
  };
  const api = {
    agentPrompt: AGENT_PROMPT,
    help: () => call('help', []) as Promise<string>,
    listTools: () => call('listTools', []),
    callTool: (name: string, args?: unknown, options?: unknown) => call('callTool', [name, args, options]),
    undo: () => call('undo', []),
    redo: () => call('redo', []),
    exportDocument: (format: 'hwp' | 'hwpx') => call('exportDocument', [format]),
    loadDocument: (bytes: Uint8Array, fileName?: string) => call('loadDocument', [bytes, fileName]),
  };
  target.csAgentTools = api;
  try {
    const w = globalThis as unknown as Record<string, unknown>;
    if (!w.hwpAgent) w.hwpAgent = api;
  } catch { /* 전역 대입이 막힌 환경 */ }

  // 1) 발견용 meta — 플러그인은 올리지 않는다.
  try {
    if (typeof document !== 'undefined' && !document.querySelector(`meta[name="${META_NAME}"]`)) {
      const meta = document.createElement('meta');
      meta.name = META_NAME;
      meta.content = META_CONTENT;
      document.head.append(meta);
    }
  } catch { /* 문서가 없는 환경 */ }

  // 1b) 「AI에게 맡기기」 복사 버튼 — 플러그인은 올리지 않는다.
  if (typeof location === 'undefined' || shouldShowHandOff(location.search)) installHandOffButton();

  // 2) WebMCP — 기능 감지. 없으면 아무것도 하지 않는다. 절대 던지지 않는다.
  try {
    const mc = (typeof document !== 'undefined' ? (document as unknown as { modelContext?: ModelContextLike }).modelContext : undefined);
    if (mc && typeof mc.registerTool === 'function') {
      const register = async () => {
        try {
          const tools = (await api.listTools()) as ToolListing[];
          for (const t of tools) {
            try {
              mc.registerTool!({
                name: t.name,
                description: t.description,
                inputSchema: t.inputSchema,
                execute: async (input: unknown) => {
                  const r = await api.callTool(t.name, plain(input ?? {}));
                  return { content: [{ type: 'text', text: JSON.stringify(r) }] };
                },
              });
            } catch { /* 한 도구 등록 실패가 나머지를 막지 않는다 */ }
          }
        } catch { /* 플러그인 로드 실패 */ }
      };
      const idle = (globalThis as unknown as { requestIdleCallback?: (cb: () => void) => unknown }).requestIdleCallback;
      if (idle) idle(() => { void register(); }); else setTimeout(() => { void register(); }, 1500);
    }
  } catch { /* WebMCP 가 이상하게 생겨도 편집기는 정상 */ }
}
