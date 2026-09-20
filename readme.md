# Distributed Rate Limiter — Build Notes

A revision doc for the rate limiter built from scratch (Node.js + Redis): every design decision, bug hit, and Redis/systems concept covered, in the order they came up.

---

## 1. Evolution of the design

| Version | Approach | Why it was replaced |
|---|---|---|
| v1 | In-memory fixed window (a plain JS object counting requests per IP) | Doesn't survive a restart, and doesn't work across multiple server instances — state is local to one process. |
| v2 | Redis-backed fixed window: `INCR` then `EXPIRE` | `INCR` and `EXPIRE` are two separate round-trips — not atomic. A crash between them leaves a key with no TTL. |
| v3 | Same, but `EXPIRE key ttl NX` (only sets TTL if none exists) | Self-healing, but still not atomic — just shrinks the race window instead of closing it. |
| v4 | Atomic Lua script via `EVAL` | Removes the race entirely (Redis runs the whole script as one indivisible step), but re-sends the full script text over the network on every single call. |
| v5 | `SCRIPT LOAD` once, then `EVALSHA` per call | Same atomicity, far less network overhead — only a hash is sent per call instead of the whole script. |
| v6 (final) | Token bucket algorithm, same `EVALSHA` pattern, values stored in a Redis Hash | Fixes the fixed-window's boundary-burst flaw (see §3) and models a continuously-refilling limit instead of a hard reset every N seconds. |

---

## 2. Bugs hit and what actually caused them

| # | Bug | Root cause | Fix |
|---|---|---|---|
| 1 | 429 response followed by a second response, or the request hanging | Missing `return` after `response.end()` — JS doesn't stop executing a function just because a branch ran; that's plain control flow, unrelated to `response` being an `EventEmitter`. | Add `return` right after every terminal `response.end()`. |
| 2 | "Poison key" — an IP gets locked out **forever** | `INCR` (sets counter) and `EXPIRE` (sets TTL) are two separate commands. If the process crashes between them, the key has a count but no expiry — it never resets. | Atomic Lua script combining both operations into one indivisible unit. |
| 3 | Rate limiter silently stopped limiting after a Redis restart, no visible error at first | `SCRIPT FLUSH` (or a Redis restart) wipes the in-memory script cache. Calling a cached `EVALSHA` hash that no longer exists throws `NOSCRIPT`. | Catch the error, check `error.message.includes('NOSCRIPT')`, and re-run `SCRIPT LOAD` to get a fresh hash. |
| 4 | The NOSCRIPT recovery "fix" didn't actually fix anything | Two separate mistakes stacked: (a) missing `await` on the recovery `evalSha` call meant `count` was a pending Promise, so `count > 5` was always `false` — the limiter was silently disabled; (b) using `const scriptHash = ...` inside the `catch` block created a **new locally-scoped variable** instead of updating the outer cached hash, so the fix never persisted past that one call. | Add `await`; declare the outer variable with `let` and reassign it (no new `const`/`let` inside the catch). |
| 5 | NOSCRIPT recovery never triggered even when it should have | Checked `error.message == 'NOSCRIPT'` (exact match). The real message is `"NOSCRIPT No matching script. Please use EVAL."` — never equal to the bare string. | Use `.startsWith('NOSCRIPT')` or `.includes('NOSCRIPT')` instead of `==`. |
| 6 | Using `ARGV[1]` for the key instead of `KEYS[1]` | Works fine on a single Redis instance, but breaks in Redis **Cluster**: Cluster routes commands by hashing declared keys to decide which shard owns them. A key hidden inside `ARGV` isn't visible to that routing layer — Redis can't guarantee the script runs on the node that actually owns the data, and cluster mode will reject it ("Lua script attempted to access a non local key"). | Always pass keys through the `KEYS[]` array, never bury a key inside `ARGV`. |
| 7 | Redis being down could **crash the entire server process**, not just fail one request | An unhandled promise rejection inside an `async` request handler is fatal in current Node — it doesn't just fail that one request. | Wrap the handler logic in `try/catch`. |
| 8 | First fix (`catch` returned `500`) was a fail-**closed** default, contradicting the intended behavior | A generic `try/catch` naturally reaches for an error status code, but for this endpoint the deliberate decision was fail-**open**: if Redis is unreachable, let the request through rather than blocking all traffic. | `catch` block sets `200` / passes the request through, while still logging the error for visibility. |
| 9 | Naive token bucket design would never actually block anything | First draft unconditionally decremented tokens with no floor check — count would go negative forever. | Only allow the request (and decrement) when `tokens >= requested`; note it's `>=`, not `> 0`, because tokens are fractional (continuous refill), not whole numbers. |

---

## 3. Algorithm concepts

**Fixed window** — count requests in a bucket keyed by a time window (e.g., 5-second buckets). Simple, but has a boundary-burst flaw: a client can send a full window's worth of requests right at the end of one window, then another full window's worth right at the start of the next — effectively 2x the intended limit in a very short span straddling the boundary.

**Token bucket** — a bucket holds up to `capacity` tokens, refilling continuously at `refillRate` tokens/sec. Each request costs `requested` tokens; allowed only if enough tokens are available. Models a smooth, continuously-refilling limit instead of a hard reset — no boundary-burst problem. Needs:
- `tokens` and `last_refill` stored together (a Redis Hash — `HMGET`/`HSET`) so both update atomically in one script.
- `now` (wall-clock time) must be computed **outside** the Lua script and passed in via `ARGV` — Lua scripts must be deterministic (no reading the system clock inside), since Redis replicates/replays scripts.
- A TTL on the key for housekeeping, so idle clients' keys eventually expire instead of living forever.

**Account-lockout DoS** — a naive "lock the account after N failed logins" defense is itself exploitable: an attacker who only knows a victim's email can deliberately trigger lockouts to lock the real user out. Mitigation: **exponential backoff** (delay grows with each failure, time-based) rather than a hard lockout, plus rate-limiting by **both** IP and account, since they catch different attack shapes (credential stuffing vs. targeted account lockout).

---

## 4. Redis features used

- `INCR` / `EXPIRE` — basic counters with TTLs (and why doing them as two separate calls isn't atomic).
- `EXPIRE key ttl NX` — only sets a TTL if the key doesn't already have one.
- `EVAL` — run a Lua script once, sending the full script text.
- `SCRIPT LOAD` — cache a script server-side, get back a SHA1 hash.
- `EVALSHA <hash>` — run a cached script by hash instead of resending the text; throws `NOSCRIPT` if the cache was cleared (restart, or `SCRIPT FLUSH`).
- `KEYS[]` vs `ARGV[]` in Lua — keys **must** go through `KEYS[]` so Redis Cluster can route the script to the node that owns the data; everything else (numbers, flags) goes through `ARGV[]`.
- `HMGET` / `HSET` — read/write multiple fields (`tokens`, `last_refill`) under one hash key.
- Key namespacing (`rateLimit:<ip>`) to avoid colliding with unrelated keys in the same Redis instance.

---

## 5. Load testing

**`autocannon`**
- `-c` — concurrent connections held open simultaneously.
- `-p` — pipelining: how many requests are kept in flight *per connection* at once (not a per-connection total count — each slot gets reused continuously). Increases raw throughput but worsens tail latency due to head-of-line blocking (a slow request blocks everything queued behind it on the same connection).
- `-d` — duration to run for.
- `-a` — exact total number of requests to send (useful for apples-to-apples comparisons across different concurrency levels, instead of "however many fit in N seconds").
- `-l` — print the detailed latency percentile table.

**`redis-benchmark`** (ships bundled with Redis itself — not an npm package; if Redis runs in Docker, run it via `docker exec -it <container> redis-benchmark ...`)
- `-n` — total commands to send, across the whole run.
- `-c` — concurrent connections (each fires requests back-to-back with no pipelining by default).
- `-q` — quiet mode, just the final summary line.
- Generic command mode: `redis-benchmark -n <N> -c <C> -q evalsha <sha> <numkeys> <keys...> <args...>` — benchmarks one specific command/script directly.

**Statistics, refreshed**
- Percentiles (p50/p97.5/p99) describe the distribution, not just the average — p50 is the median (half of requests were faster, half slower); high percentiles reveal tail latency that a mean would hide.
- Mean gets pulled around by outliers; median (p50) doesn't.
- The `Req/Sec` table in `autocannon` is sampled roughly once per second (few data points across a short run); the latency table is built from *every individual request* (far more samples) — that's why the two tables can look statistically different in reliability even from the same run.

---

## 6. Systems concepts (the "why" behind the numbers)

**Single-threaded event loop** — Redis executes one command at a time on one thread, always to completion (this is *why* Lua scripts are atomic — nothing else can run mid-script). It uses an event loop (`epoll` on Linux) that asks the OS "which sockets have data waiting?" and gets back a list — with **no fairness guarantee** on the order of that list. It just works through whatever it's handed, then asks again.

**Why throughput plateaus but latency keeps climbing under load** — since only one command executes at a time, there's a hard throughput ceiling determined by how fast one core can run this exact script. Past that ceiling, adding more concurrent clients doesn't create more parallel capacity — it just means more requests queued up waiting their turn, so latency (not throughput) is what keeps growing. Benchmarked plateau in this project: ~85–92k ops/sec for the token-bucket script — hardware/load-dependent, not a fixed constant (see below).

**`maxclients` vs. throughput ceiling — two different limits** — Redis also caps total simultaneous *connections* (`maxclients`, default 10,000) to protect its own memory/file-descriptor usage. Hitting that cap ("max number of clients reached") is a connection-count problem, unrelated to command throughput — raising it just lets more clients queue behind the same single-threaded execution limit, it doesn't create more processing capacity.

**Benchmark numbers are hardware-relative, not universal constants** — the ~90k ops/sec ceiling found here depends on this machine's CPU, Docker's resource allocation, what else was running, and the specific script's complexity. Re-running the same test on different hardware gives a different number — the number itself isn't the takeaway; the *methodology* (raise concurrency, watch throughput plateau while latency climbs, use that inflection point as your per-node capacity estimate) is what transfers to any system.

---

## 7. Not yet explored (future direction)

- **Redis Cluster** — horizontal sharding across multiple nodes once a single node's throughput ceiling is hit; directly follows from the `KEYS[]` cluster-routing requirement above.
- **Replication + Sentinel** — high availability / automatic failover if a node dies (a different concern from throughput: uptime, not capacity).
- **Multi-region tradeoffs** — global-consistent-but-slow vs. regional-approximate-but-fast, a CAP-theorem-flavored tradeoff for a globally distributed rate limiter.
- **Sliding window / sliding log** algorithms — an alternative to token bucket worth comparing tradeoffs against in an interview setting.
- **Observability** — metrics on the limiter itself (429 rate, per-client hit rate) for production visibility.

---

## 8. Final implementation reference

**`redis-cli.js`**
```javascript
import { createClient } from 'redis';
async function startRedis(){
    const client = createClient();
    client.on('error', err => console.log('Redis Client Error', err));
    await client.connect();
    return client;
}
export default startRedis;
```

**`server.js`** (token bucket, final version)
```javascript
import http from 'node:http';
import startRedis from './redis-cli.js';

let redd = await startRedis();

const luaScript = `
    local key = KEYS[1]
    local capacity = tonumber(ARGV[1])
    local refillRate = tonumber(ARGV[2])
    local requested = tonumber(ARGV[3])
    local now = tonumber(ARGV[4])

    local data = redis.call('HMGET', key, 'tokens', 'last_refill')
    local tokens = tonumber(data[1])
    local last_refill = tonumber(data[2])

    if tokens == nil or last_refill == nil then
        tokens = capacity
        last_refill = now
    else
        local elapsed = math.max(0, now - last_refill)
        tokens = math.min(capacity, tokens + elapsed * refillRate)
        last_refill = now
    end

    local allowed = 0
    if tokens >= requested then
        tokens = tokens - requested
        allowed = 1
    end

    redis.call('HSET', key, 'tokens', tokens, 'last_refill', last_refill)
    local ttl = math.ceil(capacity / refillRate) * 2
    redis.call('EXPIRE', key, math.max(ttl, 60))

    return allowed
`;

let scriptHash = await redd.scriptLoad(luaScript);

async function isAllowed(key, capacity = 5, refillRate = 1, requested = 1) {
    const now = Date.now() / 1000;
    const options = {
        keys: [key],
        arguments: [String(capacity), String(refillRate), String(requested), String(now)]
    };

    try {
        return (await redd.evalSha(scriptHash, options)) === 1;
    } catch (error) {
        if (error.message && error.message.includes('NOSCRIPT')) {
            scriptHash = await redd.scriptLoad(luaScript);
            return (await redd.evalSha(scriptHash, options)) === 1;
        }
        throw error;
    }
}

http.createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/api/resources') {
        try {
            let ip = 'rateLimit:' + request.socket.remoteAddress;
            const allowed = await isAllowed(ip, 5, 1, 1);
            if (!allowed) {
                response.statusCode = 429;
                response.end('Too Many Requests\n');
                return;
            }
            response.statusCode = 200;
            response.end('OK\n');
            return;
        } catch (error) {
            // deliberate fail-open: if Redis is unreachable, let the request through
            response.statusCode = 200;
            response.end('passed');
            console.log(error);
            return;
        }
    } else {
        response.statusCode = 404;
        response.end('Not Found\n');
        return;
    }
}).listen(8080, () => {
    console.log('Server listening on port 8080');
});
```

**`test_fetch.js`** (simple sequential test)
```javascript
const COUNT = 10
const URL = "http://localhost:8080/api/resources"
async function testEndpoint(){
    for(let i = 0; i < COUNT; i++){
        let res = await fetch(URL)
        console.log(res.status)
    }
}
testEndpoint()
```