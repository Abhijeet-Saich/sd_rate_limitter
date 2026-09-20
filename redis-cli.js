import { createClient } from 'redis';


async function startRedis(){
    const client = createClient();
    
    client.on('error', err => console.log('Redis Client Error', err));
    
    await client.connect();

    return client;
}

export default startRedis;