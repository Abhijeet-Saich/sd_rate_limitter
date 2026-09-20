import http from 'node:http';
import startRedis from './redis-cli.js';

let redd = await startRedis();

const luaScript = `
    local ip = KEYS[1]
    local count = redis.call('INCR', ip)
    if count == 1 then
        redis.call('EXPIRE', ip, 5)
    end
    return count
`;

let scriptHash = await redd.scriptLoad(luaScript);

http.createServer(async (request, response) => {

    if (request.method === 'GET' && request.url === '/api/resources') {
        let ip = 'rateLimit:' + request.socket.remoteAddress;
        let count;

        try {
            count = await redd.evalSha(scriptHash, { keys : [ip] }); 
        } catch (error) {
            //no hash was found
            console.log(error)
            if(error.message.startsWith('NOSCRIPT')){
                scriptHash = await redd.scriptLoad(luaScript);
                count = await redd.evalSha(scriptHash, { keys : [ip] } );  
            }
        }

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
