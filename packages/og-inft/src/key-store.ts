/**
 * Per-agent persistent symmetric-key store.
 *
 * Each iNFT has a long-lived AES-256-GCM key that encrypts every memory
 * snapshot the agent ever anchors. The key sits sealed-on-chain (sealed
 * under the current owner's secp256k1 pubkey via ECIES) and lives plaintext
 * on the agent's own host so the agent runtime can encrypt fresh bundles
 * without an interactive unseal step on every tick.
 *
 * The key file is gitignored. If a host is compromised, the iNFT itself is
 * compromised — same trust assumption as today's local memory.
 *
 * On ownership transfer (Phase 5 Stop 6), the off-chain ceremony reads the
 * key, re-seals it under the new owner's pubkey, and the new owner replaces
 * the key file on their host.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { generateSymmetricKey } from './crypto.ts';

export function loadOrCreateAgentKey(path: string): {
  key: Uint8Array;
  created: boolean;
} {
  if (existsSync(path)) {
    const raw = readFileSync(path);
    if (raw.length !== 32) {
      throw new Error(`agent key file ${path} has unexpected length ${raw.length}`);
    }
    return { key: new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength), created: false };
  }
  mkdirSync(dirname(path), { recursive: true });
  const key = generateSymmetricKey();
  writeFileSync(path, Buffer.from(key), { mode: 0o600 });
  return { key, created: true };
}

/** Read an existing key, throwing if missing. */
export function loadAgentKey(path: string): Uint8Array {
  const raw = readFileSync(path);
  if (raw.length !== 32) {
    throw new Error(`agent key file ${path} has unexpected length ${raw.length}`);
  }
  return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
}

export function saveAgentKey(path: string, key: Uint8Array): void {
  if (key.length !== 32) throw new Error('agent key must be 32 bytes');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.from(key), { mode: 0o600 });
}
