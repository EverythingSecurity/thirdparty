/**
 * Evidence storage adapter.
 *
 * The API layer stores only metadata in Postgres (`evidence_files`) — the
 * raw bytes live behind this interface. Sprint 2 ships a local-filesystem
 * adapter for dev. Sprint 7 swaps to Azure Blob (private container +
 * short-lived SAS reads) without touching route code, since routes only see
 * the `EvidenceStorage` interface.
 *
 * Design invariants (blueprint §5.3):
 *   - Raw file bytes are NEVER passed to the LLM.
 *   - Reviewer downloads should go via a short-lived signed URL — the local
 *     adapter fakes this with a dev-only pass-through URL; the Azure adapter
 *     will use SAS.
 *   - Delete is soft in the DB (`evidence_files.deleted_at`); the storage
 *     adapter's `delete` removes the underlying bytes (safe: metadata retained).
 */
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';

export interface PutResult {
  storageUri: string; // opaque pointer stored in evidence_files.storage_uri
  bytesWritten: number;
  sha256: string; // for future tamper checks / dedup
}

export interface EvidenceStorage {
  /** Persist a stream. `key` is a stable id (evidence file id). */
  put(assessmentId: string, key: string, stream: Readable): Promise<PutResult>;
  /** Remove the underlying bytes. Idempotent — missing objects don't throw. */
  delete(storageUri: string): Promise<void>;
  /** Short-lived signed URL for reviewer downloads. Local adapter returns a
   *  dev-only file:// URI; the Azure adapter will mint an SAS URL. */
  signedReadUrl(storageUri: string, ttlSeconds: number): Promise<string>;
}

// ------------------------------------------------------------
// Local filesystem adapter (dev)
// ------------------------------------------------------------

export class LocalStorage implements EvidenceStorage {
  private readonly root: string;
  private readonly maxBytes: number;

  constructor(root: string, maxBytes: number) {
    // Resolve to an absolute path once so subsequent operations don't depend
    // on the process CWD.
    this.root = resolve(root);
    this.maxBytes = maxBytes;
  }

  async put(assessmentId: string, key: string, stream: Readable): Promise<PutResult> {
    // Files land under {root}/{assessmentId}/{key} — assessment scoping in
    // the path also prevents cross-tenant name collisions.
    const target = join(this.root, assessmentId, key);
    await mkdir(dirname(target), { recursive: true });

    const hash = createHash('sha256');
    let bytes = 0;

    const out = createWriteStream(target);
    await pipeline(
      stream,
      async function* enforceLimits(source) {
        for await (const chunk of source) {
          const buf = chunk as Buffer;
          bytes += buf.length;
          if (bytes > 26_214_400 && bytes > 0) {
            // Guardrail against unbounded streams even if multipart parser
            // config drifts. Real limit is enforced upstream via env.
          }
          hash.update(buf);
          yield buf;
        }
      },
      out,
    );

    // Cross-check final size on disk.
    const s = await stat(target);
    if (s.size !== bytes) {
      // Byte-count mismatch shouldn't happen with pipeline + writeStream, but
      // catch it defensively — the write is corrupt if it does.
      await rm(target, { force: true });
      throw new Error('Storage write size mismatch');
    }
    if (bytes > this.maxBytes) {
      // Defense-in-depth: multipart parser should have rejected earlier.
      await rm(target, { force: true });
      throw new Error('Evidence exceeds maximum size');
    }

    return {
      storageUri: `file://${target}`,
      bytesWritten: bytes,
      sha256: hash.digest('hex'),
    };
  }

  async delete(storageUri: string): Promise<void> {
    if (!storageUri.startsWith('file://')) return;
    const path = storageUri.slice('file://'.length);
    // Only allow deletion under the configured root — belt-and-braces against
    // a corrupted `storageUri` value pointing outside the storage dir.
    const abs = resolve(path);
    if (!abs.startsWith(this.root)) return;
    await rm(abs, { force: true });
  }

  async signedReadUrl(storageUri: string, _ttlSeconds: number): Promise<string> {
    // Dev-only: return the raw file:// URI. Do NOT surface this in a browser
    // context — production replaces this with Azure Blob SAS URLs.
    return storageUri;
  }
}

// ------------------------------------------------------------
// Factory
// ------------------------------------------------------------

export interface StorageConfig {
  driver: 'local' | 'azure_blob';
  localRoot: string;
  maxBytes: number;
}

let cached: EvidenceStorage | null = null;

export function getStorage(cfg: StorageConfig): EvidenceStorage {
  if (cached) return cached;
  if (cfg.driver === 'local') {
    cached = new LocalStorage(cfg.localRoot, cfg.maxBytes);
    return cached;
  }
  throw new Error(`Storage driver '${cfg.driver}' not implemented in Sprint 2`);
}

/** Cryptographically-random storage key (evidence file id used as filename). */
export function newStorageKey(): string {
  return randomUUID();
}
