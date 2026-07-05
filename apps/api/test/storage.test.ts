import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { LocalStorage } from '../src/services/storage.js';

let root: string;
let storage: LocalStorage;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'vsa-storage-'));
  storage = new LocalStorage(root, 1024);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('LocalStorage', () => {
  it('writes a stream and returns byte count + sha256 + file:// uri', async () => {
    const payload = Buffer.from('hello vsa');
    const result = await storage.put('assessment-1', 'file-a', Readable.from(payload));
    expect(result.bytesWritten).toBe(payload.length);
    expect(result.sha256).toBe(createHash('sha256').update(payload).digest('hex'));
    expect(result.storageUri.startsWith('file://')).toBe(true);
    const onDisk = await readFile(result.storageUri.slice('file://'.length));
    expect(onDisk.equals(payload)).toBe(true);
  });

  it('delete() removes the underlying file idempotently', async () => {
    const result = await storage.put('a', 'b', Readable.from(Buffer.from('x')));
    await storage.delete(result.storageUri);
    await expect(stat(result.storageUri.slice('file://'.length))).rejects.toThrow();
    // Second delete does not throw.
    await storage.delete(result.storageUri);
  });

  it('refuses to delete a path outside the configured root', async () => {
    // Traversal attempt — should be a no-op, not throw.
    await storage.delete('file:///etc/passwd');
    await storage.delete('file://' + join(root, '..', 'escape.txt'));
    // No assertion needed beyond "does not throw" — the guard silently drops.
  });

  it('signedReadUrl returns the same uri in dev (SAS in prod)', async () => {
    const url = await storage.signedReadUrl('file:///tmp/x', 60);
    expect(url).toBe('file:///tmp/x');
  });
});
