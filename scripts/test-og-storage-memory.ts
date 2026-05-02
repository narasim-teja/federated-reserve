/**
 * Live verification for OgStorageMemory.
 *
 * Three checks:
 *
 *   1. Round-trip: write a state + log entries with one OgStorageMemory
 *      instance, force the buffer to flush, then construct a second
 *      instance pointed at a fresh local-mirror dir and confirm
 *      `loadState()` hydrates from 0G and returns the same content.
 *
 *   2. Manifest is on disk + tx hashes are present + content hash matches.
 *
 *   3. Fallback: with `OG_RPC_URL` pointed at an unreachable host, the
 *      `OgStorageMemory` instance still serves local state (uploads fail
 *      silently and stats record the failure).
 *
 * Requires:
 *   - OG_RPC_URL, OG_INDEXER_RPC pointed at a reachable 0G Galileo node
 *   - A funded signing key in WALLET_DEPLOYER_PRIVATE_KEY (or
 *     OG_STORAGE_SIGNER_PK)
 *
 * Usage:
 *   bun run scripts/test-og-storage-memory.ts
 */

import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OgStorageMemory } from '../packages/agent/src/og-storage-memory.ts';
import { makeInitialState } from '../packages/agent/src/state.ts';
import { loadAgentKey } from '../packages/og-inft/src/index.ts';

let failed = 0;
function ok(label: string): void {
  console.log(`[og-mem] ✓ ${label}`);
}
function fail(label: string, msg: string): void {
  failed += 1;
  console.error(`[og-mem] ✗ ${label}: ${msg}`);
}
function warn(label: string, msg: string): void {
  console.warn(`[og-mem] ! ${label}: ${msg}`);
}

function envOrThrow(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`required env var missing: ${key}`);
  return v;
}

async function makeTempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'og-mem-test-'));
}

// ---------------------------------------------------------------------------
// Check 1 — round-trip via 0G
// ---------------------------------------------------------------------------
async function checkRoundTrip(symmetricKey: Uint8Array | undefined): Promise<void> {
  const rpcUrl = envOrThrow('OG_RPC_URL');
  const indexerUrl = envOrThrow('OG_INDEXER_RPC');
  const signerPk =
    process.env.OG_STORAGE_SIGNER_PK ?? envOrThrow('WALLET_DEPLOYER_PRIVATE_KEY');

  const writerDir = await makeTempDir();
  const readerDir = await makeTempDir();
  try {
    const writer = new OgStorageMemory({
      agentKey: 'test',
      rootDir: writerDir,
      ogConfig: { rpcUrl, indexerUrl },
      signerPrivateKey: signerPk as `0x${string}`,
      symmetricKey,
      // Drive the test fast: tiny batches, short flush interval.
      batchSize: 4,
      flushIntervalMs: 1_000,
    });

    // Seed a state at tick 7 + 4 log entries (= one batch boundary).
    const state = makeInitialState(25);
    state.tickCount = 7;
    state.reserveRatio = 0.137;
    await writer.saveState(state);

    for (let i = 0; i < 4; i += 1) {
      await writer.appendLog({
        kind: 'broadcast_sent',
        at: new Date(Date.UTC(2026, 4, 2, 0, 0, i * 5)).toISOString(),
        summary: `entry ${i}`,
      });
    }
    // Wait for both the state upload + log batch flush to land.
    await writer.shutdown();

    const stats = writer.statsSnapshot();
    console.log(`[og-mem]   writer stats: ${JSON.stringify(stats)}`);
    if (stats.uploadsSucceeded < 2) {
      return fail(
        'roundtrip',
        `expected ≥2 uploads (state + log batch); got succeeded=${stats.uploadsSucceeded} attempted=${stats.uploadsAttempted} lastErr=${stats.lastError ?? 'none'}`,
      );
    }
    ok(`writer uploaded state + log batch (succeeded=${stats.uploadsSucceeded})`);

    // Copy the manifest the writer produced into the reader's dir so the
    // reader knows which 0G roots to fetch. (Production cold-start would
    // load this from persistent storage / EFS / S3 / iNFT metadata.)
    const writerManifest = await readFile(
      join(writerDir, 'test', 'og-manifest.json'),
      'utf8',
    );
    await Bun.write(join(readerDir, 'test', 'og-manifest.json'), writerManifest);

    // Reader is a fresh instance with no local state but the same manifest.
    const reader = new OgStorageMemory({
      agentKey: 'test',
      rootDir: readerDir,
      ogConfig: { rpcUrl, indexerUrl },
      signerPrivateKey: signerPk as `0x${string}`,
      symmetricKey,
    });

    const loaded = await reader.loadState();
    if (!loaded) return fail('roundtrip', 'reader.loadState() returned null');
    if (loaded.tickCount !== 7) {
      return fail('roundtrip', `tickCount mismatch: expected 7, got ${loaded.tickCount}`);
    }
    if (loaded.reserveRatio !== 0.137) {
      return fail(
        'roundtrip',
        `reserveRatio mismatch: expected 0.137, got ${loaded.reserveRatio}`,
      );
    }
    const readerStats = reader.statsSnapshot();
    if (readerStats.coldStartSource !== 'og') {
      return fail(
        'roundtrip',
        `expected coldStartSource=og, got ${readerStats.coldStartSource}`,
      );
    }
    ok('reader hydrated state from 0G (tick=7, reserveRatio=0.137 verified)');
    await reader.shutdown();
  } finally {
    await rm(writerDir, { recursive: true, force: true });
    await rm(readerDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Check 2 — manifest content
// ---------------------------------------------------------------------------
async function checkManifestShape(symmetricKey: Uint8Array | undefined): Promise<void> {
  const rpcUrl = envOrThrow('OG_RPC_URL');
  const indexerUrl = envOrThrow('OG_INDEXER_RPC');
  const signerPk =
    process.env.OG_STORAGE_SIGNER_PK ?? envOrThrow('WALLET_DEPLOYER_PRIVATE_KEY');

  const dir = await makeTempDir();
  try {
    const mem = new OgStorageMemory({
      agentKey: 'manifest',
      rootDir: dir,
      ogConfig: { rpcUrl, indexerUrl },
      signerPrivateKey: signerPk as `0x${string}`,
      symmetricKey,
      batchSize: 2,
      flushIntervalMs: 500,
    });
    const state = makeInitialState(6);
    state.tickCount = 1;
    await mem.saveState(state);
    await mem.appendLog({ kind: 'decision', at: '2026-05-02T00:00:00Z', summary: 'a' });
    await mem.appendLog({ kind: 'decision', at: '2026-05-02T00:00:01Z', summary: 'b' });
    await mem.shutdown();

    const raw = await readFile(join(dir, 'manifest', 'og-manifest.json'), 'utf8');
    const manifest = JSON.parse(raw) as {
      version: number;
      agent: string;
      state?: { rootHash: string; txHash: string; contentHash: string; encrypted: boolean };
      logBatches: Array<{
        rootHash: string;
        txHash: string;
        contentHash: string;
        entries: number;
        encrypted: boolean;
      }>;
    };
    if (manifest.version !== 1) return fail('manifest', `unexpected version: ${manifest.version}`);
    if (manifest.agent !== 'manifest') {
      return fail('manifest', `agent mismatch: ${manifest.agent}`);
    }
    if (!manifest.state?.rootHash?.startsWith('0x')) {
      return fail('manifest', 'state anchor missing rootHash');
    }
    if (!manifest.state.txHash?.startsWith('0x')) {
      return fail('manifest', 'state anchor missing txHash');
    }
    if (manifest.logBatches.length === 0) {
      return fail('manifest', 'no log batches recorded');
    }
    const batch = manifest.logBatches[0];
    if (!batch || batch.entries !== 2) {
      return fail('manifest', `expected batch.entries=2, got ${batch?.entries}`);
    }
    const encryptedExpected = !!symmetricKey;
    if (manifest.state.encrypted !== encryptedExpected || batch.encrypted !== encryptedExpected) {
      return fail(
        'manifest',
        `encrypted flag mismatch: expected ${encryptedExpected}, state=${manifest.state.encrypted} batch=${batch.encrypted}`,
      );
    }
    ok(
      `manifest valid — state.tx=${manifest.state.txHash.slice(0, 10)}…, ` +
        `batch.tx=${batch.txHash.slice(0, 10)}… (${batch.entries} entries, encrypted=${batch.encrypted})`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Check 3 — fallback when 0G unreachable
// ---------------------------------------------------------------------------
async function checkFallback(): Promise<void> {
  const dir = await makeTempDir();
  try {
    const mem = new OgStorageMemory({
      agentKey: 'fallback',
      rootDir: dir,
      ogConfig: {
        // Deliberately unreachable host so uploads fail fast.
        rpcUrl: 'http://127.0.0.1:1',
        indexerUrl: 'http://127.0.0.1:1',
      },
      signerPrivateKey: '0x1111111111111111111111111111111111111111111111111111111111111111',
      batchSize: 1,
      flushIntervalMs: 100,
    });
    const state = makeInitialState(48);
    state.tickCount = 99;
    await mem.saveState(state);
    await mem.appendLog({
      kind: 'reflection',
      at: '2026-05-02T01:00:00Z',
      summary: 'fallback works',
    });
    // Local-mirror reads must work even though 0G uploads fail.
    const reloaded = await mem.loadState();
    if (reloaded?.tickCount !== 99) {
      return fail('fallback', `local-mirror loadState failed: ${reloaded?.tickCount}`);
    }
    const recent = await mem.recentLog(10);
    if (recent.length !== 1) {
      return fail('fallback', `local-mirror recentLog wrong length: ${recent.length}`);
    }
    // Give the chained job time to fail.
    await mem.shutdown();
    const stats = mem.statsSnapshot();
    if (stats.uploadsFailed === 0) {
      return fail(
        'fallback',
        `expected ≥1 upload failure, got ${stats.uploadsFailed} (lastErr=${stats.lastError ?? 'none'})`,
      );
    }
    ok(
      `local-mirror serves under 0G failure (failures=${stats.uploadsFailed}, lastErr="${stats.lastError?.slice(0, 60) ?? ''}…")`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log('[og-mem] running OgStorageMemory live verification');

  // Live 0G checks are slow (each upload is a real testnet tx). Skip them
  // unless explicitly opted in with OG_LIVE=1, so iterating on the harness
  // doesn't burn faucet funds or wait minutes per change.
  const liveOg =
    !!process.env.OG_RPC_URL && !!process.env.OG_INDEXER_RPC && process.env.OG_LIVE === '1';
  if (process.env.OG_LIVE !== '1') {
    warn('live', 'OG_LIVE!=1 — skipping live roundtrip + manifest checks (set OG_LIVE=1 to run)');
  } else if (!liveOg) {
    warn('live', 'OG_RPC_URL / OG_INDEXER_RPC missing — skipping live 0G checks');
  } else if (
    !process.env.WALLET_DEPLOYER_PRIVATE_KEY ||
    process.env.WALLET_DEPLOYER_PRIVATE_KEY === '0xPLACEHOLDER'
  ) {
    warn('live', 'WALLET_DEPLOYER_PRIVATE_KEY missing — skipping live 0G checks');
  } else {
    // Try with the MA agent key if present so we exercise the encrypted path
    // too. Otherwise fall back to plaintext mode.
    let symmetricKey: Uint8Array | undefined;
    try {
      symmetricKey = loadAgentKey(join(process.cwd(), 'memory', 'ma', 'og-key.bin'));
      console.log(`[og-mem] using MA agent symmetric key (encrypted blobs)`);
    } catch {
      console.log(`[og-mem] no MA agent key — running plaintext blobs`);
    }
    await checkRoundTrip(symmetricKey);
    // No explicit between-scenario wait needed — OgStorageMemory's
    // wallet-scoped upload cooldown serializes uploads from the shared
    // signing wallet across instances.
    await checkManifestShape(symmetricKey);
  }

  await checkFallback();

  if (failed > 0) {
    console.error(`[og-mem] FAIL — ${failed} check(s) failed`);
    process.exit(1);
  }
  console.log('[og-mem] PASS');
}

main().catch((err) => {
  console.error('[og-mem] uncaught', err);
  process.exit(2);
});
