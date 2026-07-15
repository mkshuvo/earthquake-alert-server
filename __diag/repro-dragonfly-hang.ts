// Diagnostic: reproduces the production "no data after a while" failure.
//   1) HANG: ioredis with maxRetriesPerRequest:null blocks forever when
//              the server goes away. The app's saveToDragonfly, findAll,
//              search, and cleanup cron all use this client, so a single
//              Dragonfly blip freezes every request and every cron tick.
//   2) CLEANUP BUG: zremrangebyscore(eq:ids:bytime, -inf, now-24h) deletes
//              ZSET entries whose score (= earthquake time) is older than
//              24h. Since the producer fetches `significant_month` (30d),
//              any older earthquake gets removed ~10 min after being added.
//
// Run:  npx tsx __diag/repro-dragonfly-hang.ts
//       (or `ts-node __diag/repro-dragonfly-hang.ts`)

import Redis from 'ioredis';
import { execSync } from 'child_process';

function makeBuggyClient(): Redis {
  return new Redis({
    host: '127.0.0.1',
    port: 6379,
    maxRetriesPerRequest: null, // <-- the bug
    retryStrategy: (t: number) => Math.min(t * 200, 5000),
    lazyConnect: false,
  });
}

function makeSafeClient(): Redis {
  return new Redis({
    host: '127.0.0.1',
    port: 6379,
    maxRetriesPerRequest: 3,
    commandTimeout: 500,
    connectTimeout: 1000,
    enableOfflineQueue: false, // fail fast instead of buffering forever
    retryStrategy: (t: number) => Math.min(t * 200, 5000),
  });
}

function restartRedis(): void {
  try {
    execSync('wsl -d kali-linux -- bash -c "redis-cli shutdown nosave 2>&1 || true"');
  } catch {
    /* ignore */
  }
  // small delay so the port is actually free before we start again
  const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  void wait(500).then(() => {
    execSync(
      'wsl -d kali-linux -- bash -c "redis-server --daemonize yes --port 6379 --maxmemory 512mb --maxmemory-policy allkeys-lru --save \'\'"',
    );
  });
}

async function scenario1Hang(): Promise<void> {
  console.log('\n=== SCENARIO 1: HANG on Dragonfly outage (current bug) ===');
  const client = makeBuggyClient();
  await new Promise<void>((r) => client.once('ready', r));
  console.log('  initial state:', client.status);

  // stop the server to simulate the outage
  try {
    execSync('wsl -d kali-linux -- bash -c "redis-cli shutdown nosave 2>&1 || true"');
  } catch {
    /* ignore */
  }
  await new Promise((r) => setTimeout(r, 2000));

  // start a real call. This MUST time out instead of hanging.
  const t0 = Date.now();
  console.log('  calling SET on dead server with current client (maxRetriesPerRequest:null)...');
  const p = client.set('probe', 'x');
  const watchdog = new Promise<never>((_, rej) =>
    setTimeout(() => rej(new Error('did not return within 5s — confirmed HANG')), 5000),
  );
  try {
    await Promise.race([p, watchdog]);
    console.log('  call returned in', Date.now() - t0, 'ms (unexpected)');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log('  result:', msg, '(in', Date.now() - t0, 'ms)');
  }
  client.disconnect();
}

async function scenario1Fixed(): Promise<void> {
  console.log('\n=== SCENARIO 1 (FIXED): bounded latency on outage ===');
  // bring redis back so the test is meaningful
  execSync(
    'wsl -d kali-linux -- bash -c "redis-server --daemonize yes --port 6379 --maxmemory 512mb --maxmemory-policy allkeys-lru --save \'\'"',
  );
  await new Promise((r) => setTimeout(r, 1000));

  const client = makeSafeClient();
  await new Promise<void>((r) => client.once('ready', r));
  try {
    execSync('wsl -d kali-linux -- bash -c "redis-cli shutdown nosave 2>&1 || true"');
  } catch {
    /* ignore */
  }
  await new Promise((r) => setTimeout(r, 1500));

  const t0 = Date.now();
  const p = client.set('probe', 'y');
  const watchdog = new Promise<never>((_, rej) =>
    setTimeout(() => rej(new Error('still hanging after 3s')), 3000),
  );
  try {
    await Promise.race([p, watchdog]);
    console.log('  call returned in', Date.now() - t0, 'ms (unexpected — server should be down)');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log('  bounded fail in', Date.now() - t0, 'ms:', msg);
  }
  client.disconnect();
}

async function scenario2CleanupBug(): Promise<void> {
  console.log('\n=== SCENARIO 2: cleanupStaleData deletes significant_month data ===');
  execSync(
    'wsl -d kali-linux -- bash -c "redis-server --daemonize yes --port 6379 --maxmemory 512mb --maxmemory-policy allkeys-lru --save \'\'"',
  );
  await new Promise((r) => setTimeout(r, 1000));

  const client = makeSafeClient();
  await new Promise<void>((r) => client.once('ready', r));

  // Simulate two earthquakes added today:
  //   eq#1: happened 1 hour ago
  //   eq#2: happened 5 days ago  (from the significant_month feed)
  const now = Date.now();
  const recent = now - 60 * 60 * 1000;
  const old = now - 5 * 24 * 60 * 60 * 1000;

  await client.zadd('eq:ids:bytime', recent, 'eq_recent');
  await client.zadd('eq:ids:bytime', old, 'eq_old_5d');
  await client.set('eq:data:eq_recent', JSON.stringify({ id: 'eq_recent' }), 'EX', 86400);
  await client.set('eq:data:eq_old_5d', JSON.stringify({ id: 'eq_old_5d' }), 'EX', 86400);

  console.log('  before cleanup:', await client.zrange('eq:ids:bytime', 0, -1, 'WITHSCORES'));

  // Now run the EXACT same logic as cleanupStaleData
  const earthquakeDataTtlSeconds = 86400;
  const cutoff = now - earthquakeDataTtlSeconds * 1000;
  const removed = await client.zremrangebyscore('eq:ids:bytime', '-inf', cutoff);
  console.log('  removed by cleanup:', removed);

  const after = await client.zrange('eq:ids:bytime', 0, -1, 'WITHSCORES');
  console.log('  after cleanup:', after);
  console.log('  >>> BUG: eq_old_5d was removed even though its TTL is still 24h away.');
  console.log('  >>> The ZSET score represents the earthquake time, not the write time.');

  client.disconnect();
}

// silence "unused" warning for the helper
void restartRedis;

(async () => {
  try {
    await scenario1Hang();
  } catch (e) {
    console.log('  scenario1 failed:', e instanceof Error ? e.message : e);
  }
  try {
    await scenario1Fixed();
  } catch (e) {
    console.log('  scenario1-fixed failed:', e instanceof Error ? e.message : e);
  }
  try {
    await scenario2CleanupBug();
  } catch (e) {
    console.log('  scenario2 failed:', e instanceof Error ? e.message : e);
  }
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
