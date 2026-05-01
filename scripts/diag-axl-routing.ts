/**
 * AXL routing diagnostic — Phase 4 deferred fix.
 *
 * Hypothesis under test: the Phase 4 gate report claimed "leaf→leaf A2A
 * misroutes silently to the bootstrap (MA)". The Go transport (api/a2a.go +
 * internal/tcp/dial/dial.go + listen/listener.go) uses Yggdrasil's IPv6
 * destination addressing — packets are routed to the destination pubkey's
 * address regardless of spanning-tree topology. So either:
 *   (a) the misroute is real (bug in Yggdrasil routing or a misconfigured
 *       Peer/Listen)
 *   (b) it's a TCP-settle race (gVisor TCP listener takes 3-6s to accept
 *       new connections after `/topology` reports the peer)
 *   (c) it's a misobservation (the report read MA's logs because MA was
 *       acting as the *initiator* via leaf→hub fan-out, not the receiver)
 *
 * This script differentiates cleanly:
 *
 *   For each pair (from, to) in {MA, CA, TX, NY, FL, IL, WA, AK}:
 *     1. resolve `to`'s pubkey via /topology
 *     2. send `GET /a2a/{to_pubkey}` from `from`'s API (:9002, :9012, ...)
 *     3. parse the returned AgentCard `name` field
 *     4. assert name contains the expected state name (e.g. CA dialing
 *        IL_pubkey → "Illinois State Treasurer")
 *
 * If routing is correct, every pair returns the right card. If the
 * "misroute to MA" bug is real, leaf→leaf pairs return "Massachusetts
 * State Treasurer" or fail entirely.
 *
 * Run: bun run scripts/diag-axl-routing.ts   (mesh must be up)
 */

const PAIRS: Array<{ name: string; api: string }> = [
  { name: 'MA', api: 'http://127.0.0.1:9002' },
  { name: 'CA', api: 'http://127.0.0.1:9012' },
  { name: 'TX', api: 'http://127.0.0.1:9022' },
  { name: 'NY', api: 'http://127.0.0.1:9032' },
  { name: 'FL', api: 'http://127.0.0.1:9042' },
  { name: 'IL', api: 'http://127.0.0.1:9052' },
  { name: 'WA', api: 'http://127.0.0.1:9062' },
  { name: 'AK', api: 'http://127.0.0.1:9072' },
];

const STATE_NAMES: Record<string, string> = {
  MA: 'Massachusetts',
  CA: 'California',
  TX: 'Texas',
  NY: 'New York',
  FL: 'Florida',
  IL: 'Illinois',
  WA: 'Washington',
  AK: 'Alaska',
};

async function topology(api: string): Promise<{ our_public_key: string }> {
  const res = await fetch(`${api}/topology`);
  if (!res.ok) throw new Error(`${api}/topology HTTP ${res.status}`);
  return (await res.json()) as { our_public_key: string };
}

async function dialAgentCard(
  fromApi: string,
  toPubkey: string,
  attempts = 6,
): Promise<{ name?: string; error?: string }> {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${fromApi}/a2a/${toPubkey}`, { method: 'GET' });
      if (res.ok) {
        const card = (await res.json()) as { name?: string };
        return card;
      }
      const text = (await res.text()).slice(0, 200);
      if (i === attempts - 1) return { error: `${res.status}: ${text}` };
    } catch (err) {
      if (i === attempts - 1) return { error: String(err) };
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return { error: 'unreachable' };
}

console.log('[diag] resolving pubkeys...');
const pubkeys: Record<string, string> = {};
for (const p of PAIRS) {
  try {
    const t = await topology(p.api);
    pubkeys[p.name] = t.our_public_key;
    console.log(`  ${p.name}  ${t.our_public_key.slice(0, 16)}…`);
  } catch (err) {
    console.error(`  ${p.name}  FAIL: ${String(err)}`);
  }
}

const expectedHits: Array<{
  from: string;
  to: string;
  expected: string;
  saw: string;
  ok: boolean;
}> = [];
const fails: string[] = [];

console.log('\n[diag] cross-dialing AgentCard fetches');
for (const from of PAIRS) {
  for (const to of PAIRS) {
    if (from.name === to.name) continue;
    const toPub = pubkeys[to.name];
    if (!toPub) continue;
    const expectedName = `${STATE_NAMES[to.name]} State Treasurer`;
    const card = await dialAgentCard(from.api, toPub);
    const got = card.name ?? `(error: ${card.error})`;
    const ok = card.name === expectedName;
    expectedHits.push({ from: from.name, to: to.name, expected: expectedName, saw: got, ok });
    const tag = ok ? '✓' : '✗';
    const indicator =
      card.name && card.name === `${STATE_NAMES.MA} State Treasurer` && to.name !== 'MA'
        ? ' (MISROUTED TO MA)'
        : '';
    console.log(`  ${tag} ${from.name} → ${to.name.padEnd(2)}  saw "${got}"${indicator}`);
    if (!ok) fails.push(`${from.name}→${to.name}: expected "${expectedName}", got "${got}"`);
  }
}

console.log('\n[diag] summary');
const total = expectedHits.length;
const passed = expectedHits.filter((h) => h.ok).length;
console.log(`  ${passed}/${total} pairs delivered to the correct peer`);

const misrouteToMa = expectedHits.filter(
  (h) => h.to !== 'MA' && h.saw === `${STATE_NAMES.MA} State Treasurer`,
);
const errored = expectedHits.filter((h) => h.saw.startsWith('(error'));
if (misrouteToMa.length > 0) {
  console.log(`  ✗ ${misrouteToMa.length} pair(s) misrouted to MA — "leaf→leaf bug" CONFIRMED`);
}
if (errored.length > 0) {
  console.log(`  ⚠ ${errored.length} pair(s) errored out (likely TCP-settle race or gateway)`);
}
if (passed === total) {
  console.log('  ✓ leaf→leaf routing works as designed — the Phase 4 report was a misobservation');
}

if (fails.length > 0) {
  process.exit(1);
}
