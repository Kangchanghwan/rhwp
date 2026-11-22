/**
 * cs-agent-tools 핵심 로직. PluginHost 의 부분집합만 의존한다(채팅·승인 UI·네트워크 없음).
 * 도구 정의와 실행은 upstream 의 ai/tools/* 를 그대로 재사용한다(우리가 복제하지 않는다).
 */
import type { PluginHost, PluginSelectionText } from '../../rhwp-studio/src/plugin/types';
import { READ_TOOL_DEFS, executeReadTool } from '../../rhwp-studio/src/ai/tools/read-tools';
import { WRITE_TOOL_DEFS, isWriteTool, prepareWrite, WriteRefused } from '../../rhwp-studio/src/ai/tools/write-tools';
import type { PickedFile } from '../../rhwp-studio/src/ai/tools/write-tools';
import {
  COMMAND_TOOL_DEFS, isCommandTool, listAllowedCommands, selectText, prepareCommand,
} from '../../rhwp-studio/src/ai/tools/command-tools';
import { createBoundaryId } from '../../rhwp-studio/src/ai/tools/untrusted';
import { StudioCommandError } from '../../rhwp-studio/src/core/command-error';

export type ToolGroup = 'read' | 'write' | 'command';

export interface ToolInfo {
  name: string;
  group: ToolGroup;
  description: string;
  inputSchema: Record<string, unknown>;
  /** 사람(파일 선택·대화상자) 없이 호출만으로 끝나는가. false 면 callTool 에 추가 입력이 필요하다. */
  headless: boolean;
  /** headless=false 인 이유 */
  requires?: string;
}

export type ToolError = { code: string; message: string };
export type ToolResponse = { ok: true; result: unknown } | { ok: false; error: ToolError };

/** insert_picture 용 바이트. base64(또는 data URL) 또는 Uint8Array. */
export interface PictureInput {
  name?: string;
  dataBase64?: string;
  bytes?: Uint8Array;
}
export interface CallOptions { picture?: PictureInput }

/** 목록에서 뺀다: 문서를 통째로 교체하고 undo 이력을 지우며 저장 확인 흐름을 탈 수 있다. loadDocument() 를 쓴다. */
export const EXCLUDED_TOOLS: readonly string[] = ['create_document'];
/** 호출만으로 끝나지 않는 도구 → 이유 */
export const NON_HEADLESS: Readonly<Record<string, string>> = {
  insert_picture: 'options.picture (base64 또는 bytes, png/jpeg/gif/bmp) 가 필요하다.',
  select_text: '화면(편집기 선택)이 있는 구성에서만 동작한다.',
  run_command: '선택·캐럿이 필요하고 select_text 가 선행되어야 한다(화면 필요).',
  get_selection: '화면(편집기 선택)이 있는 구성에서만 의미가 있다.',
};

const NAMES = {
  read: new Set(READ_TOOL_DEFS.map((d) => d.name)),
  write: new Set(WRITE_TOOL_DEFS.map((d) => d.name)),
};

/** 승인 카드 전제 문구는 외부 에이전트에게 오해를 주므로 정리한다. */
function cleanDescription(text: string): string {
  return text.replace(/\s*(Shown|Presented) to the user for approval[^.]*\.?/gi, '').trim();
}

export function listTools(): ToolInfo[] {
  const all = [...READ_TOOL_DEFS, ...WRITE_TOOL_DEFS, ...COMMAND_TOOL_DEFS];
  return all.filter((d) => !EXCLUDED_TOOLS.includes(d.name)).map((d) => {
    const group: ToolGroup = NAMES.read.has(d.name) ? 'read' : NAMES.write.has(d.name) ? 'write' : 'command';
    const requires = NON_HEADLESS[d.name];
    return {
      name: d.name, group, description: cleanDescription(d.description),
      inputSchema: d.inputSchema as Record<string, unknown>,
      headless: requires === undefined,
      ...(requires ? { requires } : {}),
    };
  });
}

/** 읽기 결과의 `<document_content id>` 경계를 벗기고 JSON 으로 돌려준다. 값은 비신뢰 데이터다. */
function unwrapDocumentContent(content: string): unknown {
  const m = /^<document_content id="[0-9a-f]+">\n([\s\S]*)\n<\/document_content id="[0-9a-f]+">$/.exec(content);
  return JSON.parse(m ? m[1] : content);
}

function isReleased(e: unknown): boolean {
  return (e as { code?: unknown } | null)?.code === 'DOCUMENT_RELEASED';
}

/** 오류 문구 → 코드. 문구는 upstream 의 영어 메시지다. */
function refusedCode(message: string): string {
  if (/was not found|not found/i.test(message)) return 'TARGET_NOT_FOUND';
  if (/occurs \d+ times|occurrence/i.test(message)) return 'AMBIGUOUS_TARGET';
  if (/^Invalid input/i.test(message)) return 'INVALID_INPUT';
  if (/^Unknown tool/i.test(message)) return 'UNKNOWN_TOOL';
  return 'REFUSED';
}

const fail = (code: string, message: string): ToolResponse => ({ ok: false, error: { code, message } });

function b64ToBytes(b64: string): Uint8Array {
  const raw = b64.includes(',') && b64.startsWith('data:') ? b64.slice(b64.indexOf(',') + 1) : b64;
  const bin = atob(raw);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp' };

function sniffExtension(b: Uint8Array): string | null {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'gif';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'bmp';
  return null;
}

async function toPickedFile(pic: PictureInput): Promise<PickedFile> {
  const bytes = pic.bytes ?? (pic.dataBase64 ? b64ToBytes(pic.dataBase64) : null);
  if (!bytes || bytes.length === 0) throw new WriteRefused('options.picture needs dataBase64 or bytes.');
  const extension = sniffExtension(bytes);
  if (!extension) throw new WriteRefused('Picture must be png, jpeg, gif or bmp.');
  const blob = new Blob([bytes as BlobPart], { type: MIME[extension] });
  const bmp = await createImageBitmap(blob);
  const picked = { name: pic.name ?? `picture.${extension}`, bytes, extension, naturalWidth: bmp.width, naturalHeight: bmp.height };
  bmp.close();
  return picked;
}

export type ExportFormat = 'hwp' | 'hwpx';

export function createAgentToolsCore(host: PluginHost) {
  // 쓰기·명령 호출을 직렬화한다(트랜잭션 중첩 NESTED_TX 방지).
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = <T,>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => undefined);
    return next;
  };

  const writeHost = {
    read: (fn: (doc: never) => unknown) => host.read(fn as never),
    transaction: (label: string, fn: (tx: never) => unknown) => host.transaction(label, fn as never),
    // 열려 있는 create_document 는 목록에서 빼 두었다. 혹시 직접 들어와도 저장 확인 없이는 하지 않는다.
    createBlankDocument: () => Promise.resolve(false),
  };
  const commandHost = {
    read: (fn: (doc: never) => unknown) => host.read(fn as never),
    selectTextRange: (r: Parameters<PluginHost['selectTextRange']>[0]) => host.selectTextRange(r),
    getSelectionText: (): PluginSelectionText | null => host.getSelectionText(),
    automation: host.automation,
  };
  const toolHost = {
    read: (fn: (doc: never) => unknown) => host.read(fn as never),
    getSelectionText: () => host.getSelectionText(),
    getCaret: () => host.getCaret(),
  };

  async function applyProposal(proposal: ReturnType<typeof prepareWrite>, options?: CallOptions): Promise<ToolResponse> {
    if (proposal.file) {
      if (!options?.picture) return fail('FILE_REQUIRED', 'This tool needs options.picture (base64 or bytes).');
      proposal.file.provide(await toPickedFile(options.picture));
    }
    await proposal.apply();
    return {
      ok: true,
      result: {
        applied: true, location: proposal.location, newText: proposal.inserted,
        ...(proposal.note ? { note: proposal.note } : {}),
      },
    };
  }

  async function run(name: string, args: unknown, options?: CallOptions): Promise<ToolResponse> {
    const call = { id: 'cs', name, input: (args ?? {}) as Record<string, unknown> };
    try {
      if (EXCLUDED_TOOLS.includes(name)) return fail('UNKNOWN_TOOL', `${name} is not exposed; use loadDocument().`);
      if (isWriteTool(name)) return await applyProposal(prepareWrite(writeHost as never, call as never), options);
      if (isCommandTool(name)) {
        if (name === 'list_commands') return { ok: true, result: listAllowedCommands(commandHost as never) };
        if (name === 'select_text') return { ok: true, result: selectText(commandHost as never, call as never) };
        return await applyProposal(prepareCommand(commandHost as never, call as never));
      }
      const res = executeReadTool(toolHost as never, call as never, createBoundaryId());
      if (res.isError) return fail(/Unknown tool/.test(res.content) ? 'UNKNOWN_TOOL' : /^Invalid input/.test(res.content) ? 'INVALID_INPUT' : 'READ_FAILED', res.content);
      return { ok: true, result: unwrapDocumentContent(res.content) };
    } catch (error) {
      if (error instanceof StudioCommandError) await error.report.catch(() => undefined);
      if (error instanceof WriteRefused) return fail(refusedCode(error.message), error.message);
      if (isReleased(error)) return fail('DOCUMENT_RELEASED', 'No document is open, or editing is blocked right now.');
      const cause = error instanceof StudioCommandError ? error.cause : error;
      const msg = cause instanceof Error ? cause.message : String(cause);
      return fail('APPLY_FAILED', `Failed to apply the change: ${msg.slice(0, 300)}`);
    }
  }

  const exec = (id: string): ToolResponse => {
    if (!host.automation.isEnabled(id)) return fail('NOTHING_TO_DO', `${id} is not available (empty history?).`);
    const r = host.automation.execute(id);
    return r.ok ? { ok: true, result: { done: true } } : fail('COMMAND_FAILED', `${r.reason}${r.message ? `: ${r.message}` : ''}`);
  };

  return {
    listTools,
    callTool: (name: string, args?: unknown, options?: CallOptions) => enqueue(() => run(name, args, options)),
    undo: () => enqueue(async () => exec('edit:undo')),
    redo: () => enqueue(async () => exec('edit:redo')),
    /** 문서를 바꾸지 않는 읽기. 암호·손실 보고 없이 엔진 바이트만 돌려준다(저장 완료 처리 안 함). */
    exportDocument: (format: ExportFormat) => enqueue(async (): Promise<ToolResponse> => {
      try {
        if (format !== 'hwp' && format !== 'hwpx') return fail('INVALID_INPUT', 'format must be "hwp" or "hwpx".');
        const bytes = host.read((doc) => (format === 'hwp' ? doc.exportHwp() : doc.exportHwpx()));
        return { ok: true, result: { format, bytes } };
      } catch (error) {
        if (isReleased(error)) return fail('DOCUMENT_RELEASED', 'No document is open.');
        return fail('EXPORT_FAILED', error instanceof Error ? error.message : String(error));
      }
    }),
    /** 문서 교체(저장 확인 없음). create_document 대신 쓴다. */
    loadDocument: (bytes: Uint8Array, fileName?: string) => enqueue(async (): Promise<ToolResponse> => {
      try { await host.loadDocument(bytes, fileName); return { ok: true, result: { loaded: true } }; }
      catch (error) { return fail('LOAD_FAILED', error instanceof Error ? error.message : String(error)); }
    }),
  };
}
