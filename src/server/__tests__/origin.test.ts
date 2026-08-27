import { describe, it, expect } from 'vitest';
import { isLoopbackOrigin } from '../http/server.js';

describe('isLoopbackOrigin', () => {
  it('accepts loopback origins', () => {
    for (const o of ['http://localhost:3777', 'http://127.0.0.1:3777', 'http://[::1]:3777']) {
      expect(isLoopbackOrigin(o)).toBe(true);
    }
  });

  it('rejects hostnames that merely contain a loopback name', () => {
    for (const o of ['https://localhost.example.com', 'https://127.0.0.1.example.com', 'https://evil-localhost.io']) {
      expect(isLoopbackOrigin(o)).toBe(false);
    }
  });

  it('rejects garbage', () => {
    expect(isLoopbackOrigin('not a url')).toBe(false);
  });
});
