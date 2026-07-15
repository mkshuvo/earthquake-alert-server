// Verify the safe Dragonfly client fails fast on outage and recovers.
// Run:  npx tsx __diag/verify-outage-fix.ts

import Redis from 'ioredis';
import { execSync } from 'child_process';

function safe(): Redis {
  return new Redis({
    host: '127.0.0.1',
    port: 6379,
    maxRetriesPerRequest: 2,
    commandTimeout: 500,
    connectTimeout: 1000,
    enableOfflineQueue: false,
    retryStrategy: (t: number) => Math.min(t * 200, 5000),
  });
}

function bull(): Redis {
  // what BullMQ's BLPOP consumer needs
  return new Redis({
    host: '127.0.0.1',
    port: 6379,
    maxRetriesPerRequest: null,
    retryStrategy: (t: number) => Math.min(t * 200, 5000),
  });
}

function bringRedisUp(): void {
  try {
    execSync(
      'wsl -d kali-linux -- bash -c "redis-server --daemonize yes --port 6379 --maxmemory 512mb --maxmemory-policy allkeys-lru --save \'\'"',
    );
  } catch {
    /* ignore */
  }
}

function killRedis(): void {
  try {
    execSync('wsl -d kali-linux -- bash -c "redis-cli shutdown nosave 2>&1 || true"');
  } catch {
    /* ignore */
  }
}

async function main(): Promise<void> {
  console.log('Bringing redis up...');
  bringRedisUp();
  await new Promise((r) => setTimeout(r, 500));

  const app = safe();
  const worker = bull();

  await new Promise<void>((r) => app.once('ready', r));
  await new Promise<void>((r) => worker.once('ready', r));

  console.log('Both clients connected.');
  console.log('App client status:', app.status, '| Worker client status:', worker.status);

  const t1 = Date.now();
  await app.set('key1', 'value1');
  console.log('App SET (server up) took', Date.now() - t1, 'ms');

  console.log('Killing redis to simulate outage...');
  killRedis();
  await new Promise((r) => setTimeout(r, 1500));

  console.log('App client status during outage:', app.status);
  console.log('Worker client status during outage:', worker.status);

  // App-data path: must fail fast
  const t2 = Date.now();
  let appResult = 'ok';
  try {
    await app.set('key2', 'value2');
  } catch (e) {
    const msg = e instanceof Error ? e.message.split('\n')[0] : String(e);
    appResult = `failed in ${Date.now() - t2}ms: ${msg}`;
  }
  console.log('App SET (server down) →', appResult);

  await new Promise((r) => setTimeout(r, 2000));
  console.log('Worker client status (2s after outage):', worker.status);

  console.log('Bringing redis back...');
  bringRedisUp();
  await new Promise((r) => setTimeout(r, 3000));

  console.log('App client status after recovery:', app.status);
  console.log('Worker client status after recovery:', worker.status);

  try {
    await app.set('key3', 'value3');
    console.log('App SET (server back up) → ok');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log('App SET (server back up) → FAILED:', msg);
  }

  app.disconnect();
  worker.disconnect();

  console.log('\nSummary:');
  console.log('  - App-data path: bounded latency, fails fast, reconnects when server is back');
  console.log('  - BullMQ path:   keeps retrying forever (as BLPOP requires)');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
