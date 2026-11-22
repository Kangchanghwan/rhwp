/**
 * `window.rhwpStudio.csAgentTools` — 같은 페이지 JS 용 게으른 진입점. 처음 부를 때 플러그인을 올린다.
 * (코드가 작아 시작 번들에 정적으로 들어가지만, 도구 코드는 플러그인 청크라 부르기 전엔 로드되지 않는다.)
 *
 *   await rhwpStudio.csAgentTools.listTools()
 *   await rhwpStudio.csAgentTools.callTool('replace_text', { find, replace })  // -> {ok,result}|{ok:false,error:{code,message}}
 *   await rhwpStudio.csAgentTools.undo() / redo() / exportDocument('hwpx'|'hwp') / loadDocument(bytes, name)
 */
const ID = 'cs-agent-tools';

interface Registry {
  load(id: string): Promise<unknown>;
  invoke(id: string, method: string, args: unknown[]): unknown;
}

export function installCsAgentToolsGlobal(plugins: Registry, target: Record<string, unknown>): void {
  let ready: Promise<unknown> | null = null;
  const call = async (method: string, args: unknown[]) => {
    ready ??= plugins.load(ID).catch((e) => { ready = null; throw e; });
    await ready;
    return plugins.invoke(ID, method, args);
  };
  target.csAgentTools = {
    listTools: () => call('listTools', []),
    callTool: (name: string, args?: unknown, options?: unknown) => call('callTool', [name, args, options]),
    undo: () => call('undo', []),
    redo: () => call('redo', []),
    exportDocument: (format: 'hwp' | 'hwpx') => call('exportDocument', [format]),
    loadDocument: (bytes: Uint8Array, fileName?: string) => call('loadDocument', [bytes, fileName]),
  };
}
