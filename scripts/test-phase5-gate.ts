import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const OBSERVER = process.env.OBSERVER_URL ?? 'http://127.0.0.1:3001';
const OBSERVER_AXL = process.env.OBSERVER_AXL_URL ?? 'http://127.0.0.1:9102';
const OBSERVER_ROUTER = process.env.OBSERVER_ROUTER_URL ?? 'http://127.0.0.1:9103';
const MA_AXL = process.env.MA_AXL_URL ?? 'http://127.0.0.1:9002';
const MANIFEST = process.env.INFT_MANIFEST_PATH ?? join(ROOT, '.data/inft-manifest.json');

let failed = 0;
const failures: string[] = [];

function ok(label: string): void {
  console.log(`[p5-gate] ✓ ${label}`);
}

function fail(label: string, message: string): void {
  failed += 1;
  failures.push(`${label}: ${message}`);
  console.error(`[p5-gate] ✗ ${label}: ${message}`);
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

async function observerPubkey(): Promise<string> {
  const top = await getJson<{ our_public_key: string }>(`${OBSERVER_AXL}/topology`);
  return top.our_public_key;
}

async function maSeesObserver(pubkey: string): Promise<boolean> {
  const top = await getJson<{
    peers?: Array<{ public_key: string }>;
    tree?: Array<{ public_key: string }>;
  }>(`${MA_AXL}/topology`);
  return [...(top.peers ?? []), ...(top.tree ?? [])].some((p) => p.public_key === pubkey);
}

async function callObserverMcp(pubkey: string): Promise<void> {
  const res = await fetch(`${MA_AXL}/mcp/${pubkey}/treasurer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: randomUUID(),
      method: 'tools/call',
      params: {
        name: 'share_economic_indicator',
        arguments: {
          state_fips: 25,
          indicator: 'unemployment',
          value: 4.2,
          timestamp: new Date().toISOString(),
          source: 'PHASE5_GATE',
        },
      },
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`observer MCP HTTP ${res.status}: ${text}`);
}

async function waitForIndicator(): Promise<boolean> {
  for (let i = 0; i < 12; i++) {
    const snap = await getJson<{
      states: Array<{ abbr: string; latest_indicator?: { source?: string } | null }>;
    }>(`${OBSERVER}/snapshot`);
    if (snap.states.some((s) => s.abbr === 'MA' && s.latest_indicator?.source === 'PHASE5_GATE')) {
      return true;
    }
    await Bun.sleep(1000);
  }
  return false;
}

async function wsReceivesSnapshot(): Promise<boolean> {
  return await new Promise((resolve) => {
    const ws = new WebSocket(`${OBSERVER.replace(/^http/, 'ws')}/ws`);
    const timer = setTimeout(() => {
      ws.close();
      resolve(false);
    }, 5000);
    ws.onmessage = (msg) => {
      const parsed = JSON.parse(String(msg.data)) as { kind?: string };
      if (parsed.kind === 'mesh_snapshot') {
        clearTimeout(timer);
        ws.close();
        resolve(true);
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      resolve(false);
    };
  });
}

console.log('[p5-gate] starting Phase 5 observer gate');

try {
  await getJson(`${OBSERVER}/healthz`);
  ok('observer health endpoint reachable');
} catch (err) {
  fail('observer-health', String(err));
}

try {
  const servicesText = await fetch(`${OBSERVER_ROUTER}/services`).then((r) => r.text());
  if (servicesText.includes('treasurer')) ok('observer registered treasurer MCP service');
  else fail('observer-router', `treasurer missing from /services: ${servicesText.slice(0, 200)}`);
} catch (err) {
  fail('observer-router', String(err));
}

let pubkey = '';
try {
  pubkey = await observerPubkey();
  ok(`observer AXL pubkey resolved ${pubkey.slice(0, 12)}…`);
} catch (err) {
  fail('observer-topology', String(err));
}

if (pubkey) {
  try {
    if (await maSeesObserver(pubkey)) ok('MA topology sees observer peer');
    else fail('agent-discovery', 'MA topology does not include observer pubkey yet');
  } catch (err) {
    fail('agent-discovery', String(err));
  }

  try {
    await callObserverMcp(pubkey);
    ok('MA → observer share_economic_indicator over AXL/MCP returned 200');
  } catch (err) {
    fail('observer-mcp', String(err));
  }
}

try {
  if (await waitForIndicator()) ok('observer snapshot recorded Phase 5 indicator');
  else fail('observer-snapshot', 'PHASE5_GATE indicator not found in observer snapshot');
} catch (err) {
  fail('observer-snapshot', String(err));
}

try {
  if (await wsReceivesSnapshot()) ok('observer WebSocket emits initial mesh_snapshot');
  else fail('observer-ws', 'no mesh_snapshot over WebSocket within 5s');
} catch (err) {
  fail('observer-ws', String(err));
}

try {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as { entries?: unknown[] };
  if (existsSync(MANIFEST) && manifest.entries?.length === 8) {
    ok('iNFT manifest has all 8 deep-state entries');
  } else {
    fail('inft-manifest', `expected 8 entries, got ${manifest.entries?.length ?? 0}`);
  }
} catch (err) {
  fail('inft-manifest', String(err));
}

if (process.env.CHECK_FRONTEND === '1') {
  try {
    const res = await fetch('http://127.0.0.1:3000');
    if (res.ok) ok('frontend dev server reachable');
    else fail('frontend', `HTTP ${res.status}`);
  } catch (err) {
    fail('frontend', String(err));
  }
}

if (failed > 0) {
  console.error(`\n[p5-gate] ${failed} failure(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log('\n[p5-gate] ✓ PASS');
