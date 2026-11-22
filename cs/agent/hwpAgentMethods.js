/**
 * hwpAgent 의 공개 함수 이름. bridge.js 는 이 목록(guard 제외)만 부모의 요청으로 실행한다.
 * Clipboard Share 의 frontend/src/services/hwpAgentMethods.js 와 같은 목록이어야 한다. hwpAgent.test.js 가 실제 객체와 같은지 확인한다.
 */
export const AGENT_METHODS = [
  'outline', 'find', 'getTable', 'listObjects', 'check',
  'replaceParagraph', 'insertParagraphAfter', 'deleteParagraphs', 'setParaShape', 'setCharShape',
  'insertTable', 'deleteObject', 'edit', 'undo', 'redo', 'status', 'dismissRecovery', 'dismissDialogs', 'dialogs', 'guard',
]
