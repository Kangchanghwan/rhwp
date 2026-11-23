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
 * 시작 때 하는 일(플러그인을 올리지 않는다): <meta name="ai-agent-api"> 삽입.
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
