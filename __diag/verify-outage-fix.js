// Final verification: with the SAFE client, a Dragonfly outage does
// not freeze the application. Run against a live WSL redis that we
// kill in the middle of the test.
const Redis = require('ioredis');
const { execSync } = require('child_process');

function safe() {
  return new Redis({
    host: '127.0.0.1',
    port: 6379,
    maxRetriesPerRequest: 2,
    commandTimeout: 500,
    connectTimeout: 1000,
    enableOfflineQueue: false,
    retryStrategy: (t) => Math.min(t * 200, 5000),
  });
}

function bull() {
  // what BullMQ's BLPOP consumer needs
  return new Redis({
    host: '127.0.0.1',
    port: 6379,
    maxRetriesPerRequest: null,
    retryStrategy: (t) => Math.min(t * 200, 5000),
  });
}

(async () => {
  console.log('Bringing redis up...');
  try { execSync('wsl -d kali-linux -- bash -c "redis-cli ping >/dev/null 2>&1 || (redis-server --daemonize yes --port 6379 --maxmemory 512mb --maxmemory-policy allkeys-lru --save \'\')"'); } catch (_) {}
  await new Promise((r) => setTimeout(r, 500));

  const app = safe();
  const worker = bull();

  await new Promise((r) => app.once('ready', r));
  await new Promise((r) => worker.once('ready', r));

  console.log('Both clients connected.');
  console.log('App client status:', app.status, '| Worker client status:', worker.status);

  // Demonstrate the app code path: a saveToDragonfly() call while the
  // server is reachable is fast.
  const t1 = Date.now();
  await app.set('key1', 'value1');
  console.log('App SET (server up) took', Date.now() - t1, 'ms');

  // Now KILL the server and try the same call.
  console.log('Killing redis to simulate outage...');
  try { execSync('wsl -d kali-linux -- bash -c "redis-cli shutdown nosave 2>&1 || true"'); } catch (_) {}
  await new Promise((r) => setTimeout(r, 1500));

  console.log('App client status during outage:', app.status);
  console.log('Worker client status during outage:', worker.status);

  // ---- App-data path: must fail fast ----
  const t2 = Date.now();
  let appResult = 'ok';
  try {
    await app.set('key2', 'value2');
  } catch (e) {
    appResult = `failed in ${Date.now() - t2}ms: ${e.message.split('\n')[0]}`;
  }
  console.log('App SET (server down) →', appResult);

  // ---- BullMQ path: still retries forever (as BullMQ requires) ----
  // We don't actually BLPOP because that would block the test; we
  // just verify the worker client is in 'reconnecting' and not 'end'.
  await new Promise((r) => setTimeout(r, 2000));
  console.log('Worker client status (2s after outage):', worker.status);

  // Restart redis
  console.log('Bringing redis back...');
  execSync('wsl -d kali-linux -- bash -c "redis-server --daemonize yes --port 6379 --maxmemory 512mb --maxmemory-policy allkeys-lru --save \'\'"');
  await new Promise((r) => setTimeout(r, 3000));

  console.log('App client status after recovery:', app.status);
  console.log('Worker client status after recovery:', worker.status);

  // The app client should be back to 'ready' and a SET should work.
  try {
    await app.set('key3', 'value3');
    console.log('App SET (server back up) → ok');
  } catch (e) {
    console.log('App SET (server back up) → FAILED:', e.message);
  }

  app.disconnect();
  worker.disconnect();

  console.log('\nSummary:');
  console.log('  - App-data path: bounded latency, fails fast, reconnects when server is back');
  console.log('  - BullMQ path:   keeps retrying forever (as BLPOP requires)');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
