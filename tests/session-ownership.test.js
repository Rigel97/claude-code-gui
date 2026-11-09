import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

describe('SessionOwnership identity boundary', () => {
  it('prevents duplicate writers and stale release cannot unlock a newer owner', () => {
    const { SessionOwnership } = require('../src/main/session-ownership.js');
    const registry = new SessionOwnership();
    const first = { conversationId: 'same' };
    const second = { conversationId: 'same' };
    const release = registry.acquire('session', first);
    expect(registry.owner('session')).toBe(first);
    expect(() => registry.acquire('session', second)).toThrow(/owned/);
    release();
    registry.acquire('session', second);
    release();
    registry.releaseOwner(first);
    expect(registry.owner('session')).toBe(second);
    registry.releaseOwner(second);
    expect(registry.owner('session')).toBeUndefined();
  });
});
