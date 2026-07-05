import { describe, it, expect } from 'vitest';
import { ALLOWED_MIME } from '../src/services/evidence.js';

describe('evidence mime allow-list', () => {
  it('includes exactly the four documented types', () => {
    expect([...ALLOWED_MIME].sort()).toEqual(
      [
        'application/pdf',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'image/jpeg',
        'image/png',
      ].sort(),
    );
  });

  it('rejects executables, archives, and unknown types', () => {
    for (const bad of [
      'application/x-msdownload',
      'application/zip',
      'text/html',
      'application/javascript',
      'text/plain',
      'application/octet-stream',
    ]) {
      expect(ALLOWED_MIME.has(bad)).toBe(false);
    }
  });
});
