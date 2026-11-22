/**
 * 내장 플러그인 `cs-agent-tools` — 채팅·LLM·승인 카드 없이 문서 도구(읽기 8·쓰기 29·명령 3)를 직접 호출한다.
 * 쓰기는 자동 적용(호출 1회 = undo 1스텝). 표면은 구조화 복제 가능한 값만 돌려준다(embed RPC 호환).
 * 설계: cs/docs/AI_TOOLS_FINDINGS.ko.md
 */
import { PLUGIN_API_VERSION } from '../../rhwp-studio/src/plugin/types';
import type { PluginHost, PluginSurface, StudioPlugin } from '../../rhwp-studio/src/plugin/types';
import { createAgentToolsCore } from './agent-tools-core';

export const csAgentToolsPlugin: StudioPlugin = {
  id: 'cs-agent-tools',
  apiVersion: PLUGIN_API_VERSION,
  activate(host: PluginHost): PluginSurface {
    return createAgentToolsCore(host) as unknown as PluginSurface;
  },
};
