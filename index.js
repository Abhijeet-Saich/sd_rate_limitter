import http from 'node:http';
import startRedis from './redis-cli.js';

let redd = await startRedis();

http.createServer(async (request, response) => {

    if (request.method === 'GET' && request.url === '/api/resources') {
        let ip = 'rateLimit:' + request.socket.remoteAddress;

        const luaScript = `
            local ip = KEYS[1]
            local count = redis.call('INCR', ip)
            if count == 1 then
                redis.call('EXPIRE', ip, 5)
            end
            return count
        `;

        let count = await redd.eval(luaScript, { keys : [ip] })

        if (count > 5) {
            response.statusCode = 429; // Rate limit exceeded
            response.end();
            return;
        }

        response.statusCode = 200;
        response.end()
        return;

    } else {
      response.statusCode = 404;
      response.end();
      return;
    }
  }).listen(8080);
