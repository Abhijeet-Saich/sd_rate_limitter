
const COUNT = 10
const URL = "http://localhost:8080/api/resources"



async function testEndpoint(){
    let start = Date.now();
    for(let i = 0; i < COUNT; i++){
        let res = await fetch(URL)
        console.log(res.status)
    }
    let timeTaken = Date.now() - start
    console.log(`Total Time Taken : ${timeTaken}`)
}


testEndpoint()