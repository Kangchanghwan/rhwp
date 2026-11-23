/**
 * cs-agent-tools 핵심 로직. PluginHost 의 부분집합만 의존한다(채팅·승인 UI·네트워크 없음).
 * 도구 정의와 실행은 upstream 의 ai/tools/* 를 그대로 재사용한다(우리가 복제하지 않는다).
 */
import type { PluginHost, PluginSelectionText, Tx } from '../../rhwp-studio/src/plugin/types';
import { READ_TOOL_DEFS, executeReadTool } from '../../rhwp-studio/src/ai/tools/read-tools';
import { WRITE_TOOL_DEFS, isWriteTool, prepareWrite, WriteRefused } from '../../rhwp-studio/src/ai/tools/write-tools';
import type { PickedFile } from '../../rhwp-studio/src/ai/tools/write-tools';
import {
  COMMAND_TOOL_DEFS, isCommandTool, listAllowedCommands, selectText, prepareCommand,
} from '../../rhwp-studio/src/ai/tools/command-tools';
import { createBoundaryId, cleanDocumentText } from '../../rhwp-studio/src/ai/tools/untrusted';
import { StudioCommandError } from '../../rhwp-studio/src/core/command-error';
import {
  NEW_TOOL_DEFS, findNewToolDef, validateSchema, summarizeTables, findTable, readTableData, tableCells, cellText,
  planSetCells, applyCellOps, verifyCellOps, planFillFields, verifyFills, validatePlanShape,
  PLAN_FORBIDDEN_TOOLS, findProducedByEarlierStep, buildHelp,
} from './agent-tools-pure';
import type { TableDoc, TableWriter, TableRef, FieldRow, PlanIssue } from './agent-tools-pure';

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

export type ToolError = { code: string; message: string; details?: unknown };
/** 실패(ok:false)에도 result 가 붙을 수 있다 — run_plan 의 {applied:false, invalid|failedAt, …}. */
export type ToolResponse = { ok: true; result: unknown } | { ok: false; error: ToolError; result?: unknown };

/** insert_picture 용 바이트. base64(또는 data URL) 또는 Uint8Array. */
export interface PictureInput {
  name?: string;
  dataBase64?: string;
  bytes?: Uint8Array;
}
export interface CallOptions {
  picture?: PictureInput;
  /** true 면 쓰기 도구는 바뀔 내용만 보고하고 문서를 바꾸지 않는다(검증만, 문서 변경 0). */
  dryRun?: boolean;
}

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
  const base = all.filter((d) => !EXCLUDED_TOOLS.includes(d.name)).map((d) => {
    const group: ToolGroup = NAMES.read.has(d.name) ? 'read' : NAMES.write.has(d.name) ? 'write' : 'command';
    const requires = NON_HEADLESS[d.name];
    return {
      name: d.name, group, description: cleanDescription(d.description),
      inputSchema: d.inputSchema as Record<string, unknown>,
      headless: requires === undefined,
      ...(requires ? { requires } : {}),
    };
  });
  // 기존 40개는 그대로 두고 뒤에 새 도구를 붙인다(이름·순서 호환).
  const added: ToolInfo[] = NEW_TOOL_DEFS.map((d) => ({
    name: d.name, group: d.group, description: d.description,
    inputSchema: d.inputSchema as unknown as Record<string, unknown>, headless: true,
  }));
  return [...base, ...added];
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

const fail = (code: string, message: string, details?: unknown): ToolResponse => ({ ok: false, error: { code, message, ...(details !== undefined ? { details } : {}) } });

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

/** run_plan 실행 중 실패를 바깥 트랜잭션에 알려 롤백시키는 신호 */
class PlanAbort extends Error {}

function errorToResponse(error: unknown): ToolResponse {
  if (error instanceof WriteRefused) return fail(refusedCode(error.message), error.message);
  if (isReleased(error)) return fail('DOCUMENT_RELEASED', 'No document is open, or editing is blocked right now.');
  const cause = error instanceof StudioCommandError ? error.cause : error;
  const msg = cause instanceof Error ? cause.message : String(cause);
  return fail('APPLY_FAILED', `Failed to apply the change: ${msg.slice(0, 300)}`);
}

interface SearchHitLite { sec: number; para: number; cellContext?: { parentPara: number; ctrlIdx: number } }

export function createAgentToolsCore(host: PluginHost) {
  // 쓰기·명령 호출을 직렬화한다(트랜잭션 중첩 NESTED_TX 방지).
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = <T,>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => undefined);
    return next;
  };

  /**
   * run_plan 이 바깥 트랜잭션을 쥐고 있는 동안 값이 있다. 이때 안쪽 쓰기 도구의 transaction 은
   * 새 트랜잭션을 열지 않고 바깥 것을 그대로 쓴다(중첩 NESTED_TX 방지 + 계획 전체가 undo 1스텝, 실패 시 전체 롤백).
   */
  let activeTx: Tx | null = null;
  const runTx = <T,>(label: string, fn: (tx: Tx) => T): T => (activeTx ? fn(activeTx) : host.transaction(label, fn));

  const writeHost = {
    read: (fn: (doc: never) => unknown) => host.read(fn as never),
    transaction: (label: string, fn: (tx: never) => unknown) => runTx(label, fn as never),
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

  const readDoc = <T,>(fn: (doc: TableDoc & { searchAllText(q: string, cs: boolean, cells: boolean): string; getFieldList(): string; getDocumentInfo(): string }) => T): T =>
    host.read((doc) => fn(doc as never));
  const pageCount = (): number => readDoc((d) => {
    const n = (JSON.parse(d.getDocumentInfo()) as { pageCount?: number }).pageCount;
    return Number.isSafeInteger(n) ? n! : 0;
  });
  const countHits = (query: string): number => readDoc((d) => (JSON.parse(d.searchAllText(query, true, true)) as unknown[]).length);

  // ───────────── 새 도구: 표 ─────────────

  const noTable = (table: number): ToolResponse => {
    const n = readDoc((d) => summarizeTables(d, cleanDocumentText).length);
    return fail('TABLE_NOT_FOUND', `table ${table} does not exist; the document has ${n} table(s) (0-based). Call list_tables.`);
  };

  function listTablesTool(): ToolResponse {
    return { ok: true, result: readDoc((d) => summarizeTables(d, cleanDocumentText).map((t) => ({
      table: t.table, section: t.section, rows: t.rows, cols: t.cols, hasMerge: t.hasMerge,
      firstCellText: t.firstCellText, precedingText: t.precedingText,
    }))) };
  }

  function readTableTool(input: Record<string, unknown>): ToolResponse {
    const table = input.table as number;
    const maxRows = input.maxRows as number | undefined;
    const out = readDoc((d) => { const ref = findTable(d, table); return ref ? readTableData(d, ref, cleanDocumentText, maxRows) : null; });
    return out ? { ok: true, result: out } : noTable(table);
  }

  function setCellsTool(input: Record<string, unknown>, dry: boolean): ToolResponse {
    const table = input.table as number;
    const edits = input.cells as Array<{ row: number; col: number; text: string }>;
    const plan = readDoc((d) => {
      const ref = findTable(d, table);
      return ref ? { ref, ...planSetCells(d, ref, edits, cleanDocumentText) } : null;
    });
    if (!plan) return noTable(table);
    if (plan.issues.length > 0) {
      const first = plan.issues[0];
      const more = plan.issues.length > 1 ? ` (+${plan.issues.length - 1} more issue(s); nothing was written)` : ' (nothing was written)';
      return fail(first.code, `${first.message}${more}`, plan.issues);
    }
    const changed = plan.ops.map((o) => ({ row: o.row, col: o.col, oldText: o.oldText, newText: o.newText }));
    if (dry) return { ok: true, result: { dryRun: true, applied: false, changed, unchanged: plan.unchanged } };
    if (plan.ops.length === 0) return { ok: true, result: { changed, unchanged: plan.unchanged, verified: true } };
    runTx('AI: 칸 쓰기', (tx) => applyCellOps(tx.doc() as unknown as TableWriter, plan.ref, plan.ops));
    const verified = readDoc((d) => verifyCellOps(d, plan.ref, plan.ops, cleanDocumentText));
    return { ok: true, result: { changed, unchanged: plan.unchanged, verified } };
  }

  // ───────────── 새 도구: 누름틀 ─────────────

  function fillFieldsTool(input: Record<string, unknown>, dry: boolean, strict: boolean): ToolResponse {
    const values = input.values as Record<string, unknown>;
    const fields = readDoc((d) => JSON.parse(d.getFieldList()) as FieldRow[]);
    const plan = planFillFields(fields, values, cleanDocumentText);
    if (strict && (plan.notFound.length || plan.ambiguous.length || plan.invalid.length)) {
      const first = plan.invalid[0]
        ? ['INVALID_INPUT', `fill_fields: ${plan.invalid[0].name}: ${plan.invalid[0].message}`]
        : plan.notFound.length
          ? ['TARGET_NOT_FOUND', `fill_fields: no field named ${plan.notFound.map((n) => `"${n}"`).join(', ')}. Call list_fields.`]
          : ['AMBIGUOUS_TARGET', `fill_fields: ${plan.ambiguous.map((a) => `"${a.name}" matches ${a.matched} fields`).join(', ')}; use "name[N]".`];
      return fail(first[0], first[1], { notFound: plan.notFound, ambiguous: plan.ambiguous, invalid: plan.invalid });
    }
    const filled = [
      ...plan.fills.map((f) => ({ name: f.name, occurrence: f.occurrence, oldValue: f.oldValue, value: f.value, changed: true })),
      ...plan.unchanged.map((f) => ({ name: f.name, occurrence: f.occurrence, oldValue: f.value, value: f.value, changed: false })),
    ];
    const report = { filled, notFound: plan.notFound, ambiguous: plan.ambiguous, invalid: plan.invalid };
    if (dry) return { ok: true, result: { dryRun: true, applied: false, ...report } };
    if (plan.fills.length === 0) return { ok: true, result: { ...report, verified: true } };
    runTx('AI: 누름틀 채우기', (tx) => {
      const w = tx.doc() as unknown as { setFieldValue(id: number, v: string): string };
      for (const f of plan.fills) {
        const r = JSON.parse(w.setFieldValue(f.fieldId, f.value)) as { ok?: boolean };
        if (!r.ok) throw new Error(`setFieldValue failed for "${f.name}"`);
      }
    });
    const verified = verifyFills(readDoc((d) => JSON.parse(d.getFieldList()) as FieldRow[]), plan.fills, cleanDocumentText);
    return { ok: true, result: { ...report, verified } };
  }

  // ───────────── 기존 쓰기 도구: 결과와 verified ─────────────

  type Proposal = ReturnType<typeof prepareWrite>;

  /** 쓰기 전에 확인 기준을 잡는다(독립 재읽기에 쓴다). */
  function capturePre(name: string, args: Record<string, unknown>, proposal: Proposal): (() => boolean) | null {
    try {
      if (name === 'replace_text') {
        const oldCtx = proposal.prefix + proposal.removed + proposal.suffix;
        const newCtx = proposal.prefix + proposal.inserted + proposal.suffix;
        const before = { oldCtx: countHits(oldCtx), newCtx: newCtx ? countHits(newCtx) : 0 };
        return () => (newCtx ? countHits(newCtx) > before.newCtx : countHits(oldCtx) < before.oldCtx);
      }
      if (name === 'set_cell_text') {
        const find = args.find as string;
        const occurrence = (args.occurrence as number | undefined) ?? 1;
        const row = (args.row as number) - 1;
        const col = (args.column as number) - 1;
        const text = args.text as string;
        const target = readDoc((d) => {
          const hits = JSON.parse(d.searchAllText(find, true, true)) as SearchHitLite[];
          const cell = hits[occurrence - 1]?.cellContext;
          if (!cell) return null;
          const ref: TableRef = { table: -1, section: hits[occurrence - 1].sec, para: cell.parentPara, ctrl: cell.ctrlIdx };
          const info = tableCells(d, ref).cells.find((c) => c.row === row && c.col === col);
          return info ? { ref, cellIndex: info.index } : null;
        });
        if (!target) return () => false;
        return () => readDoc((d) => cellText(d, target.ref, target.cellIndex, cleanDocumentText) === text);
      }
    } catch { return () => false; }
    return null;
  }

  function writeResult(proposal: Proposal, verify: (() => boolean) | null) {
    let verified: boolean | undefined;
    if (verify) { try { verified = verify(); } catch { verified = false; } }
    return {
      applied: true, location: proposal.location, newText: proposal.inserted,
      ...(proposal.note ? { note: proposal.note } : {}),
      ...(verified !== undefined ? { verified } : {}),
    };
  }

  function dryRunResult(proposal: Proposal) {
    return {
      dryRun: true, applied: false, location: proposal.location,
      oldText: proposal.removed, newText: proposal.inserted,
      ...(proposal.prefix ? { before: proposal.prefix } : {}), ...(proposal.suffix ? { after: proposal.suffix } : {}),
      ...(proposal.format ? { format: proposal.format } : {}),
      ...(proposal.note ? { note: proposal.note } : {}),
    };
  }

  async function applyProposal(proposal: Proposal, options?: CallOptions, name?: string, args?: Record<string, unknown>): Promise<ToolResponse> {
    if (proposal.file) {
      if (!options?.picture) return fail('FILE_REQUIRED', 'This tool needs options.picture (base64 or bytes).');
      proposal.file.provide(await toPickedFile(options.picture));
    }
    const verify = name && args ? capturePre(name, args, proposal) : null;
    await proposal.apply();
    return { ok: true, result: writeResult(proposal, verify) };
  }

  /** run_plan 의 한 단계(동기 — 바깥 트랜잭션 안에서 돈다). */
  function stepSync(name: string, args: Record<string, unknown>): ToolResponse {
    try {
      if (findNewToolDef(name)) return newToolSync(name, args, false, true);
      if (isWriteTool(name)) {
        const proposal = prepareWrite(writeHost as never, { id: 'cs', name, input: args } as never);
        if (proposal.file) return fail('FILE_REQUIRED', `${name} needs a file and cannot run inside a plan.`);
        const verify = capturePre(name, args, proposal);
        const r = proposal.apply() as unknown;
        if (r && typeof (r as Promise<unknown>).then === 'function') throw new Error(`${name} is asynchronous and cannot run inside a plan.`);
        return { ok: true, result: writeResult(proposal, verify) };
      }
      const res = executeReadTool(toolHost as never, { id: 'cs', name, input: args } as never, createBoundaryId());
      if (res.isError) return fail(/^Invalid input/.test(res.content) ? 'INVALID_INPUT' : 'READ_FAILED', res.content);
      return { ok: true, result: unwrapDocumentContent(res.content) };
    } catch (error) {
      return errorToResponse(error);
    }
  }

  function newToolSync(name: string, args: Record<string, unknown>, dry: boolean, strict: boolean): ToolResponse {
    const def = findNewToolDef(name)!;
    const bad = validateSchema(def.inputSchema, args);
    if (bad) return fail('INVALID_INPUT', `Invalid input: ${bad}`);
    switch (name) {
      case 'list_tables': return listTablesTool();
      case 'read_table': return readTableTool(args);
      case 'set_cells': return setCellsTool(args, dry);
      case 'fill_fields': return fillFieldsTool(args, dry, strict);
      default: return fail('UNKNOWN_TOOL', `Unknown tool: ${name}`);
    }
  }

  // ───────────── run_plan ─────────────

  function toolNames(): Set<string> { return new Set(listTools().map((t) => t.name)); }

  function validateSteps(steps: Array<{ tool: string; args: Record<string, unknown> }>) {
    const names = toolNames();
    const issues: PlanIssue[] = [];
    const previews: unknown[] = [];
    steps.forEach((step, index) => {
      const bad = (code: string, message: string) => issues.push({ index, code, message });
      const { tool, args } = step;
      if (PLAN_FORBIDDEN_TOOLS[tool]) return bad('STEP_NOT_ALLOWED', PLAN_FORBIDDEN_TOOLS[tool]);
      if (!names.has(tool)) return bad('UNKNOWN_TOOL', `Unknown tool: ${tool}. Call listTools().`);
      const earlier = steps.slice(0, index).map((s) => s.args);
      try {
        if (findNewToolDef(tool)) {
          if (tool === 'set_cells' || tool === 'fill_fields') {
            const r = newToolSync(tool, args, true, true);
            if (!r.ok) {
              const deferred = r.error.code === 'TARGET_NOT_FOUND' && earlier.length > 0;
              if (!deferred) bad(r.error.code, r.error.message);
            } else previews.push({ index, tool, preview: r.result });
          } else {
            const r = newToolSync(tool, args, true, true);
            if (!r.ok) bad(r.error.code, r.error.message);
          }
          return undefined;
        }
        if (isWriteTool(tool)) {
          const proposal = prepareWrite(writeHost as never, { id: 'cs', name: tool, input: args } as never);
          if (proposal.file) return bad('STEP_NOT_ALLOWED', `${tool} needs a file and cannot run inside a plan.`);
          previews.push({ index, tool, preview: dryRunResult(proposal) });
          return undefined;
        }
        const res = executeReadTool(toolHost as never, { id: 'cs', name: tool, input: args } as never, createBoundaryId());
        if (res.isError) bad(/^Invalid input/.test(res.content) ? 'INVALID_INPUT' : 'READ_FAILED', res.content);
      } catch (error) {
        const r = errorToResponse(error);
        if (!r.ok) {
          // 앞 단계가 만들 글을 뒤 단계가 찾는 연쇄 계획은 실행 때 검증한다(실패하면 전체 롤백).
          const deferred = r.error.code === 'TARGET_NOT_FOUND' && findProducedByEarlierStep(args.find ?? args.after, earlier);
          if (!deferred) bad(r.error.code, r.error.message);
        }
      }
      return undefined;
    });
    return { issues, previews };
  }

  async function runPlan(input: Record<string, unknown>): Promise<ToolResponse> {
    const dry = input.dryRun === true;
    const shape = validatePlanShape(input.steps);
    if (!shape.ok) return fail('INVALID_INPUT', `Invalid input: ${shape.error}`);
    const { steps } = shape;
    const { issues, previews } = validateSteps(steps);
    if (issues.length > 0) {
      return {
        ok: false,
        error: { code: 'PLAN_INVALID', message: `${issues.length} step(s) invalid; nothing was changed. First: step ${issues[0].index} ${issues[0].code}: ${issues[0].message}` },
        result: { applied: false, dryRun: dry, invalid: issues },
      };
    }
    if (dry) return { ok: true, result: { applied: false, dryRun: true, valid: true, steps: previews } };

    const pageCountBefore = pageCount();
    const results: unknown[] = [];
    let abort: { failedAt: number; error: ToolError } | null = null;
    try {
      host.transaction('AI: 계획 실행', (tx) => {
        activeTx = tx;
        try {
          for (let i = 0; i < steps.length; i += 1) {
            const r = stepSync(steps[i].tool, steps[i].args);
            if (!r.ok) { abort = { failedAt: i, error: r.error }; throw new PlanAbort('plan step failed'); }
            results.push(r.result);
          }
        } finally { activeTx = null; }
      });
    } catch (error) {
      if (error instanceof StudioCommandError) await error.report.catch(() => undefined);
      const a = abort as { failedAt: number; error: ToolError } | null;
      if (a) {
        return {
          ok: false,
          error: { code: 'PLAN_FAILED', message: `step ${a.failedAt} (${steps[a.failedAt].tool}) failed: ${a.error.code}: ${a.error.message}. Everything was rolled back.` },
          result: { applied: false, failedAt: a.failedAt, rolledBack: true, error: a.error, pageCount: pageCountBefore },
        };
      }
      const r = errorToResponse(error);
      return {
        ok: false,
        error: r.ok ? { code: 'APPLY_FAILED', message: 'plan failed' } : r.error,
        result: { applied: false, failedAt: results.length, rolledBack: true },
      };
    }
    const allVerified = results.every((r) => (r as { verified?: unknown })?.verified !== false);
    return { ok: true, result: { applied: true, steps: results, pageCountBefore, pageCountAfter: pageCount(), verified: allVerified } };
  }

  // ───────────── 호출 ─────────────

  async function run(name: string, args: unknown, options?: CallOptions): Promise<ToolResponse> {
    const input = (args ?? {}) as Record<string, unknown>;
    const call = { id: 'cs', name, input };
    const dry = options?.dryRun === true;
    try {
      if (EXCLUDED_TOOLS.includes(name)) return fail('UNKNOWN_TOOL', `${name} is not exposed; use loadDocument().`);
      if (name === 'run_plan') {
        const bad = validateSchema(findNewToolDef('run_plan')!.inputSchema, input);
        if (bad) return fail('INVALID_INPUT', `Invalid input: ${bad}`);
        return await runPlan(dry ? { ...input, dryRun: true } : input);
      }
      if (findNewToolDef(name)) return newToolSync(name, input, dry, false);
      if (isWriteTool(name)) {
        const proposal = prepareWrite(writeHost as never, call as never);
        if (dry) return { ok: true, result: dryRunResult(proposal) };
        return await applyProposal(proposal, options, name, input);
      }
      if (isCommandTool(name)) {
        if (dry && name !== 'list_commands' && name !== 'select_text') return fail('DRYRUN_UNSUPPORTED', 'dryRun is not supported for run_command.');
        if (name === 'list_commands') return { ok: true, result: listAllowedCommands(commandHost as never) };
        if (name === 'select_text') return { ok: true, result: selectText(commandHost as never, call as never) };
        return await applyProposal(prepareCommand(commandHost as never, call as never));
      }
      const res = executeReadTool(toolHost as never, call as never, createBoundaryId());
      if (res.isError) return fail(/Unknown tool/.test(res.content) ? 'UNKNOWN_TOOL' : /^Invalid input/.test(res.content) ? 'INVALID_INPUT' : 'READ_FAILED', res.content);
      return { ok: true, result: unwrapDocumentContent(res.content) };
    } catch (error) {
      if (error instanceof StudioCommandError) await error.report.catch(() => undefined);
      return errorToResponse(error);
    }
  }

  const exec = (id: string): ToolResponse => {
    if (!host.automation.isEnabled(id)) return fail('NOTHING_TO_DO', `${id} is not available (empty history?).`);
    const r = host.automation.execute(id);
    return r.ok ? { ok: true, result: { done: true } } : fail('COMMAND_FAILED', `${r.reason}${r.message ? `: ${r.message}` : ''}`);
  };

  return {
    listTools,
    /** 에이전트용 짧은 사용 설명서(한국어 + 핵심 영어). */
    help: () => buildHelp(listTools()),
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
