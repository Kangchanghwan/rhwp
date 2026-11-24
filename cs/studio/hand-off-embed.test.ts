import { describe, it, expect } from 'vitest';
import { shouldShowHandOff } from './agent-tools-global';

describe('「AI에게 맡기기」 버튼', () => {
  it('?embed=cs 에서는 숨기고, 직접 접속에서는 보인다', () => {
    expect(shouldShowHandOff('?embed=cs&theme=dark')).toBe(false);
    expect(shouldShowHandOff('')).toBe(true);
    expect(shouldShowHandOff('?theme=dark')).toBe(true);
    expect(shouldShowHandOff('?embed=other')).toBe(true);
  });
});
