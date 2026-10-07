import assert from 'node:assert/strict';
import { loadConfig } from '../extensions/hive-remote/config.ts';
import remote from '../extensions/hive-remote/index.ts';
import { registerWorkspaceTools } from '../extensions/hive-remote/workspace.ts';
const registered = new Map();
let network = 0, clones = 0;
const pi = {registerTool:t=>registered.set(t.name,t),registerCommand:()=>{},on:()=>{},events:{on:()=>{}},registerShortcut:()=>{},registerMessageRenderer:()=>{},exec:async()=>{clones++; return {code:0,stdout:'',stderr:''};}};
remote(pi,{loadConfig:()=>({...loadConfig(),enabled:false,allowAddWorkspace:false}),resolveAuth:()=>null});
console.log('disabled registration:', {request:registered.has('request_workspace'),catalog:registered.has('list_workspace_catalog')});
const errors=[];
try {assert(registered.has('request_workspace'),'disabled request tool must offer actionable diagnostics');} catch(e) {errors.push(e.message);}
registered.clear();
const json=(status,body)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
globalThis.fetch=async(url,init)=>{network++; if(url.endsWith('/workspace-catalog')) return json(200,{entries:[{name:'hive',repo:'Artifex-org/hive'}]}); if(init?.method==='POST') return json(200,{id:'g1',verdict:'approve'}); if(url.endsWith('/value')) return json(410,{detail:'already delivered'}); throw Error('unexpected '+url);};
registerWorkspaceTools(pi,{enabled:true,getAuth:()=>({url:'https://hive.test',token:'test'}),getSessionID:()=> 'sess'});
const result=await registered.get('request_workspace').execute('call',{repo:'hive'});
console.log('delivered retry:',result.content[0].text);
console.log('trace:',{network,clones});
try {assert.match(result.content[0].text,/was already granted and delivered/,'410 must be explained as delivered, not empty approval');} catch(e) {errors.push(e.message);}
if(errors.length){console.error(errors.join('\n'));process.exitCode=1;}
