import { describe, expect, it } from 'vitest';
import { toggleMemorySelection } from '../src/ui/memory-manager';

describe('memory metadata card selection', () => {
  it('opens a different card and closes the currently open card', () => {
    expect(toggleMemorySelection('', 'memory-a')).toBe('memory-a');
    expect(toggleMemorySelection('memory-a', 'memory-b')).toBe('memory-b');
    expect(toggleMemorySelection('memory-a', 'memory-a')).toBe('');
  });
});
