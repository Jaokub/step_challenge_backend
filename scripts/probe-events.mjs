/**
 * BUILD_PLAN.md Phase 9, Task 1 (ADR-002): confirm whether the `Event` /
 * `EventParticipant` tables actually hold any data before retiring the
 * events surface.
 *
 * Why this exists: the sandbox that did the Phase 9 analysis cannot reach
 * Neon (DNS is not allowlisted) and its checked-in Prisma query engine was
 * generated for Windows, so a direct DB query was impossible from there —
 * same constraint that produced `smoke-leaderboard.mjs`. This script goes
 * through the deployed API instead, so it runs anywhere with network access.
 *
 * What it tells you:
 *   - how many Events exist at all
 *   - how many are UPCOMING/ONGOING (i.e. what the old admin-dashboard
 *     "openEvents" KPI was counting)
 *   - how many participants each one has
 *
 * If the count is 0, the Event model is confirmed dead data and ADR-002's
 * Option C ("defer Events, keep the tables dormant") is safe as written.
 * If it is NOT 0, stop and re-read ADR-002 — real data exists and the
 * decision needs revisiting before anything is deleted.
 *
 * Requires an ADMIN account (GET /events is authenticated).
 *
 * Usage:
 *   node scripts/probe-events.mjs --email <admin-account> --password ****
 *   BASE_URL=http://localhost:3000/api/v1 node scripts/probe-events.mjs --email ... --password ...
 *
 * Prefer the env-var form so the password stays out of your shell history:
 *   SMOKE_EMAIL=... SMOKE_PASSWORD=... node scripts/probe-events.mjs
 *
 * Never hard-code a real account here — the deployed backend is public.
 *
 * Defaults to the deployed Vercel backend.
 */

const args = process.argv.slice(2);
const getArg = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
};

const BASE_URL = process.env.BASE_URL || 'https://step-challenge-backend.vercel.app/api/v1';
const email = getArg('--email') || process.env.SMOKE_EMAIL;
const password = getArg('--password') || process.env.SMOKE_PASSWORD;

if (!email || !password) {
  console.error('Usage: node scripts/probe-events.mjs --email <email> --password <password>');
  console.error('(or set SMOKE_EMAIL / SMOKE_PASSWORD env vars)');
  process.exit(1);
}

const main = async () => {
  console.log(`Target: ${BASE_URL}`);

  const loginRes = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const loginBody = await loginRes.json();
  if (!loginRes.ok || !loginBody?.data?.accessToken) {
    console.error('Login response:', JSON.stringify(loginBody, null, 2));
    console.error(`\n❌ login failed (HTTP ${loginRes.status})`);
    process.exitCode = 1;
    return;
  }
  const token = loginBody.data.accessToken;
  console.log('✅ Logged in.');

  const res = await fetch(`${BASE_URL}/events`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.json();

  if (res.status !== 200) {
    console.error('Response:', JSON.stringify(body, null, 2));
    console.error(`\n❌ GET /events returned HTTP ${res.status}`);
    process.exitCode = 1;
    return;
  }

  const events = body?.data ?? body ?? [];
  if (!Array.isArray(events)) {
    console.error('Response:', JSON.stringify(body, null, 2));
    console.error('\n❌ GET /events did not return an array');
    process.exitCode = 1;
    return;
  }

  const open = events.filter((e) => e.status === 'UPCOMING' || e.status === 'ONGOING');

  console.log(`\n=== Event table ===`);
  console.log(`Total events:            ${events.length}`);
  console.log(`Open (UPCOMING/ONGOING): ${open.length}   <- what the old "openEvents" KPI counted`);

  if (events.length === 0) {
    console.log('\n✅ CONFIRMED DEAD. The Event table is empty.');
    console.log('   ADR-002 Option C stands: no user data is lost by retiring the events UI,');
    console.log('   and the dormant backend tables can stay as they are.');
    return;
  }

  console.log('\n⚠️  NOT EMPTY — real Event rows exist. Details:\n');
  for (const e of events) {
    const participants = e.participants?.length ?? e._count?.participants ?? '?';
    console.log(
      `  ${e.id}  [${e.status}]  "${e.title}"  ${e.startDate} → ${e.endDate}  participants=${participants}`
    );
  }
  console.log('\n   Re-read ADR-002 before deleting anything — the "dead data" premise does not hold.');
  process.exitCode = 1;
};

main().catch((err) => {
  console.error('\n❌ Probe crashed:', err);
  process.exitCode = 1;
});
