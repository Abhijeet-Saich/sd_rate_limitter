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
                response.statusCode = 429; // Rate limit exceeded
                response.end('Too Many Requests\n');
                return;
            }
    
            response.statusCode = 200;
            response.end('OK\n');
            return;
            
        } catch (error) {
            response.statusCode = 200;
            response.end('passed');
            console.log(error)
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

