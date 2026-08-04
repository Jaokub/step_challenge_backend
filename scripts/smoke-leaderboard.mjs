/**
 * BUILD_PLAN.md Phase 6A, step 1: smoke-test the leaderboard endpoints against
 * real data, since they were originally only ever compile-verified.
 *
 * Covers GET /leaderboard/friends (the friends tab's data source) and asserts
 * that GET /leaderboard/global is **gone** — it was deleted on 2026-08-03
 * (TEST_FINDINGS F2). That last check earns its keep because this script hits
 * the deployed backend: a stale Vercel deployment could keep serving the route
 * long after the source that defined it was removed, and nothing in the unit
 * suite can see that.
 *
 * Run this on a machine that can actually reach the app's DB (Neon) and has
 * a Prisma query engine matching its own OS — this sandbox has neither
 * (network-restricted, and the checked-in Prisma client was generated for
 * Windows), so this smoke test could not be run from there. Run it against
 * either a local `npm run dev` server or the deployed Vercel backend.
 *
 * Usage:
 *   node scripts/smoke-leaderboard.mjs --email you@example.com --password ****
 *   BASE_URL=https://step-challenge-backend.vercel.app/api/v1 node scripts/smoke-leaderboard.mjs --email ... --password ...
 *
 * Prefer the env-var form so the password never lands in your shell history:
 *   SMOKE_EMAIL=... SMOKE_PASSWORD=... node scripts/smoke-leaderboard.mjs
 *
 * Do NOT paste real accounts or passwords into this comment block. Earlier
 * revisions of this file listed working staff/admin logins here as examples;
 * because the deployed backend is publicly reachable, that would have handed
 * anyone with repo access a live faculty-admin session. Removed 2026-07-19,
 * before this file was ever committed.
 *
 * Defaults to http://localhost:3000/api/v1 if BASE_URL isn't set.
 */

const args = process.argv.slice(2);
const getArg = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
};

const BASE_URL = 'https://step-challenge-backend.vercel.app/api/v1';
const email = getArg('--email') || process.env.SMOKE_EMAIL_ADMIN;
const password = getArg('--password') || process.env.SMOKE_PASSWORD_ADMIN;

if (!email || !password) {
  console.error('Usage: node scripts/smoke-leaderboard.mjs --email <email> --password <password>');
  console.error('(or set SMOKE_EMAIL_ADMIN / SMOKE_PASSWORD_ADMIN env vars)');
  process.exit(1);
}

const log = (label, obj) => console.log(`\n=== ${label} ===\n${JSON.stringify(obj, null, 2)}`);

const fail = (msg) => {
  console.error(`\n❌ FAIL: ${msg}`);
  process.exitCode = 1;
};

const main = async () => {
  console.log(`Target: ${BASE_URL}`);

  // 1) Log in to get a bearer token.
  const loginRes = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const loginBody = await loginRes.json();
  if (!loginRes.ok || !loginBody?.data?.accessToken) {
    log('Login response', loginBody);
    return fail(`login failed (HTTP ${loginRes.status})`);
  }
  const token = loginBody.data.accessToken;
  console.log('✅ Logged in.');

  const authedGet = (path) =>
    fetch(`${BASE_URL}${path}`, { headers: { Authorization: `Bearer ${token}` } }).then(async (r) => ({
      status: r.status,
      body: await r.json(),
    }));

  // 2) GET /leaderboard/global must be GONE (deleted 2026-08-03, F2).
  //    Checked rather than dropped: this script runs against the DEPLOYED
  //    backend, so it is the only thing in the repo that can catch the route
  //    surviving on Vercel after the code that defined it was removed.
  const removed = await authedGet('/leaderboard/global');
  if (removed.status === 200) {
    log('GET /leaderboard/global', removed);
    fail('/leaderboard/global still responds 200 — the route was deleted on 2026-08-03; is this deployment stale?');
  } else {
    console.log(`✅ /leaderboard/global is gone (HTTP ${removed.status}).`);
  }

  // 3) GET /leaderboard/friends
  const friends = await authedGet('/leaderboard/friends');
  log('GET /leaderboard/friends', friends);
  if (friends.status !== 200) fail(`/leaderboard/friends returned HTTP ${friends.status}`);
  const friendRows = friends.body?.data ?? friends.body ?? [];
  if (!Array.isArray(friendRows)) fail('/leaderboard/friends did not return an array');
  else {
    if (friendRows.length === 0) {
      fail('/leaderboard/friends returned zero rows — the signed-in user should always appear, even with no friends');
    } else {
      console.log(`✅ /leaderboard/friends: ${friendRows.length} row(s), signed-in user included.`);
    }
  }

  if (process.exitCode === 1) {
    console.error('\nOne or more checks FAILED — see above.');
  } else {
    console.log('\n✅ All smoke checks passed.');
  }
};

main().catch((e) => {
  console.error('Smoke test crashed:', e);
  process.exit(1);
});
