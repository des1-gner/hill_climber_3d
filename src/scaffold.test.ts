import { describe, it, expect } from 'vitest';

// Minimal smoke test so the test runner has a target before the logic layer
// (tasks 2-6) is implemented. This verifies the toolchain (Vitest + TS) works.
describe('project scaffold', () => {
  it('runs the test runner', () => {
    expect(1 + 1).toBe(2);
  });
});
