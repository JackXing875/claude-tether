import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createServer as tcpServer, createConnection } from 'node:net';
import { mkdtemp, writeFile, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
if (!process.env.CCPROXY_TEST_BINARY) throw new Error('Set CCPROXY_TEST_BINARY to the separately installed ccproxy executable');
const devices = await readFile('/proc/net/dev', 'utf8');
if (devices.split('\n').some(line => line.includes(':') && line.split(':')[0].trim() !== 'lo')) throw new Error('Run this synthetic test in a loopback-only bwrap network namespace');
const directory = await mkdtemp(join(tmpdir(), 'tether-ccproxy-synthetic-'));
const free = async () => { const s=tcpServer();s.listen(0,'127.0.0.1');await once(s,'listening');const p=s.address().port;await new Promise(r=>s.close(r));return p; };
const proxyPort=await free(),webPort=await free();
const seen=[];
const sse='event: message_start\ndata: {"type":"message_start","message":{"id":"synthetic","type":"message","role":"assistant","model":"synthetic","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{}"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';
const origin=createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{
 seen.push({path:req.url,headers:req.headers,body:JSON.parse(body||'{}')});
 if(req.url.includes('error'))res.writeHead(429,{'retry-after':'42'}).end('{"error":{"type":"rate_limit_error","message":"synthetic"}}');
 else if(req.url.includes('count_tokens'))res.setHeader('content-type','application/json').end('{"input_tokens":17}');
 else{res.writeHead(200,{'content-type':'text/event-stream'});res.write(sse.slice(0,30));setTimeout(()=>res.end(sse.slice(30)),80);}
});});origin.listen(0,'127.0.0.1');await once(origin,'listening');
await writeFile(join(directory,'ccproxy.yaml'),JSON.stringify({ccproxy:{
 host:'127.0.0.1',port:proxyPort,log_level:'ERROR',log_file:null,verify_readiness_on_startup:false,
 inspector:{port:webPort,cert_dir:join(directory,'certs'),mitmproxy:{ssl_insecure:false,flow_detail:0,termlog_verbosity:'error'}},
 providers:{},shaping:{enabled:false},hooks:{inbound:[],outbound:[]},otel:{enabled:false},mcp:{http:{enabled:false}},
 lightllm:{transforms:[{match_path:'^/v1/',action:'redirect',dest_base_url:'http://127.0.0.1:'+origin.address().port}]}
}}));
const env={...process.env,HOME:directory,XDG_CONFIG_HOME:directory,CCPROXY_CONFIG_DIR:directory};
for(const k of Object.keys(env))if(/^(ANTHROPIC_|CLAUDE_|CCPROXY_(?!CONFIG_DIR)|.*_PROXY$|.*_proxy$)/.test(k))delete env[k];
env.CCPROXY_VERIFY_READINESS_ON_STARTUP = 'false';
const child=spawn(process.env.CCPROXY_TEST_BINARY,['start'],{env,stdio:['ignore','pipe','pipe']});
const closed=once(child,'close');let stderr='';child.stdout.on('data',c=>stderr+=c);child.stderr.on('data',c=>stderr+=c);
const report={upstream:'f2c47695b0835da023257aee0ac2a3dffd9fe570',syntheticCredentialsOnly:true,results:[]};
try{
 let ready=false;for(let i=0;i<150;i++){if(child.exitCode!==null)throw new Error('ccproxy exited '+child.exitCode);ready=await new Promise(r=>{const s=createConnection({host:'127.0.0.1',port:proxyPort});s.on('connect',()=>{s.destroy();r(true)});s.on('error',()=>r(false));});if(ready)break;await delay(100);}
 assert.ok(ready,'startup timed out');
 for(const [path,model] of [['messages?beta=true','sonnet-test'],['messages?beta=true','opus-test'],['messages/count_tokens','count-test'],['messages?error=true','error-test']]){
  const body={model,messages:[{role:'user',content:'synthetic'}],stream:true,metadata:{user_id:'synthetic-user'},tools:[{name:'fixture',input_schema:{type:'object'}}]};
  const response=await fetch('http://127.0.0.1:'+proxyPort+'/v1/'+path,{method:'POST',headers:{authorization:'Bearer synthetic-no-real-credential','anthropic-version':'2023-06-01','anthropic-beta':'synthetic-beta','content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
  const text=await response.text();const actual=seen.at(-1);
  assert.deepEqual(actual?.body,body);assert.equal(actual.headers.authorization,'Bearer synthetic-no-real-credential');assert.equal(actual.headers['anthropic-beta'],'synthetic-beta');
  if(model==='error-test'){assert.equal(response.status,429);assert.equal(response.headers.get('retry-after'),'42');}
  else if(model==='count-test')assert.equal(JSON.parse(text).input_tokens,17);
  else{assert.equal(response.status,200);assert.equal(text,sse);}
  report.results.push({model,status:response.status,preserved:true});
 }
 assert.equal(seen.length,4);report.passed=true;
}catch(e){report.passed=false;report.error=e.message;report.diagnostics=stderr.slice(-2500);process.exitCode=1;}
finally{child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),3000);await closed;clearTimeout(timer);origin.closeAllConnections();await new Promise(r=>origin.close(r));report.createdFiles=await readdir(directory);console.log(JSON.stringify(report));await rm(directory,{recursive:true,force:true});}
