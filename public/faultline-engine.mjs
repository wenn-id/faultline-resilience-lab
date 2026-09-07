/** Faultline deterministic simulation engine. MIT License, 2026 Faultline contributors. */
export const ENGINE_VERSION='1.0.0';
const round=n=>Math.round(n*100)/100;
const percentile=(values,p)=>{if(!values.length)return 0;const a=[...values].sort((a,b)=>a-b);return round(a[Math.max(0,Math.ceil(a.length*p)-1)]);};
export function validateConfig(c){
 const fail=m=>{throw new Error(m);};
 const number=(v,lo,hi,label,integer=false)=>{if(!Number.isFinite(v)||v<lo||v>hi||(integer&&!Number.isInteger(v)))fail(`${label} must be ${integer?'an integer ':''}between ${lo} and ${hi}.`);};
 if(!c||typeof c!=='object'||c.version!==1)fail('Expected a Faultline version 1 experiment.');
 if(typeof c.name!=='string'||!c.name.trim()||c.name.length>80)fail('Experiment name must contain 1–80 characters.');
 number(c.seed,0,2147483647,'Seed',true);number(c.rps,1,200,'Traffic (RPS)',true);number(c.duration,1,90,'Duration',true);
 if(!Array.isArray(c.services)||c.services.length<1||c.services.length>12)fail('Use between 1 and 12 services.');
 const ids=new Set();
 for(const s of c.services){
  if(!s||typeof s.id!=='string'||!/^[a-z][a-z0-9-]{0,31}$/.test(s.id)||['constructor','prototype'].includes(s.id)||ids.has(s.id))fail('Service IDs must be unique lowercase identifiers.');
  ids.add(s.id);if(typeof s.name!=='string'||!s.name.trim()||s.name.length>40)fail('Service names must contain 1–40 characters.');
  if(!['gateway','service','database','cache','external'].includes(s.kind))fail('Unrecognized service kind.');
  number(s.latency,1,3000,'Service latency');number(s.capacity,1,500,'Service capacity',true);number(s.errorRate,0,1,'Error probability');
  if(!Array.isArray(s.dependencies)||s.dependencies.length>6||new Set(s.dependencies).size!==s.dependencies.length)fail('Use up to 6 unique dependencies per service.');
 }
 if(!ids.has(c.entry))fail('The entry service must exist.');
 for(const s of c.services)for(const d of s.dependencies)if(!ids.has(d))fail(`Dependency ${String(d)} does not exist.`);
 const visiting=new Set(),visited=new Set(),graph=new Map(c.services.map(s=>[s.id,s]));
 const visit=id=>{if(visiting.has(id))fail('Dependency cycle detected. Use a directed acyclic graph.');if(visited.has(id))return;visiting.add(id);graph.get(id).dependencies.forEach(visit);visiting.delete(id);visited.add(id);};
 visit(c.entry);if(visited.size!==ids.size)fail('Every service must be reachable from the entry service.');
 if(!c.policy)fail('A resilience policy is required.');number(c.policy.timeout,10,10000,'Timeout');number(c.policy.retries,0,2,'Retries',true);number(c.policy.backoff,0,2000,'Backoff');
 if(typeof c.policy.jitter!=='boolean'||typeof c.policy.circuitBreaker!=='boolean')fail('Jitter and circuit breaker must be boolean values.');
 const f=c.fault;if(!f||typeof f.enabled!=='boolean'||!ids.has(f.target))fail('Choose an existing fault target.');
 if(!['latency','errors','outage','capacity'].includes(f.type))fail('Choose a supported fault type.');
 number(f.start,0,90,'Fault start');number(f.duration,1,90,'Fault duration');number(f.value,f.type==='capacity'?1:0,f.type==='latency'?5000:100,'Fault intensity');return c;
}
class EventQueue{
 items=[];
 before(a,b){return a.time<b.time||(a.time===b.time&&a.order<b.order);}
 push(e){const a=this.items;a.push(e);let i=a.length-1;while(i>0){const p=(i-1)>>1;if(!this.before(a[i],a[p]))break;[a[p],a[i]]=[a[i],a[p]];i=p;}}
 pop(){const a=this.items,root=a[0],last=a.pop();if(a.length){a[0]=last;let i=0;for(;;){let n=i,l=i*2+1,r=l+1;if(l<a.length&&this.before(a[l],a[n]))n=l;if(r<a.length&&this.before(a[r],a[n]))n=r;if(n===i)break;[a[i],a[n]]=[a[n],a[i]];i=n;}}return root;}
 compact(){const live=this.items.filter(e=>e.fn!==null);this.items=[];for(const e of live)this.push(e);}
}
export function simulate(raw,options={}){
 const config=validateConfig(raw),{policy,fault}=config,queue=new EventQueue();let now=0,order=0,spanId=0;
 const noise=key=>{let h=(2166136261^config.seed)>>>0;for(let i=0;i<key.length;i++)h=Math.imul(h^key.charCodeAt(i),16777619)>>>0;h^=h>>>16;h=Math.imul(h,0x7feb352d);h^=h>>>15;h=Math.imul(h,0x846ca68b);h^=h>>>16;return(h>>>0)/4294967296;};
 const schedule=(time,fn)=>{if(queue.items.length>=30000)queue.compact();if(order>=2000000||queue.items.length>=30000)throw new Error('This graph creates too much work. Reduce traffic, duration, dependencies, or retries.');const e={time,fn,order:order++};queue.push(e);return e;};
 const definitions=new Map(config.services.map(s=>[s.id,s]));
 const states=new Map(config.services.map(s=>[s.id,{calls:0,errors:0,retries:0,timeouts:0,rejected:0,cancelled:0,circuitRejected:0,active:0,peakActive:0,latencies:[],successes:0,circuit:'closed',consecutive:0,openUntil:0,probe:false}]));
 const events=[],addEvent=(kind,service,message)=>{if(events.length<160)events.push({time:round(now),kind,service,message});};
 const hasFault=fault.enabled&&!options.baseline;
 if(hasFault){schedule(fault.start*1000,()=>addEvent('fault',fault.target,`${fault.type} injection started`));schedule((fault.start+fault.duration)*1000,()=>addEvent('recovery',fault.target,'Fault window ended'));}
 const faultActive=id=>hasFault&&id===fault.target&&now>=fault.start*1000&&now<(fault.start+fault.duration)*1000;
 function invoke(id,request,callback,parentId,path){
  let cancelled=false,settled=false,attemptNumber=0,cancelAttempt=()=>{},pendingRetry=null;
  const def=definitions.get(id),state=states.get(id);
  const finishLogical=(ok,status)=>{if(settled||cancelled)return;settled=true;callback(ok,status);};
  const attempt=()=>{
   if(cancelled||settled)return;pendingRetry=null;const currentAttempt=attemptNumber++;if(currentAttempt>0)state.retries++;
   if(policy.circuitBreaker&&state.circuit!=='closed'){
    if(now<state.openUntil||state.probe){state.circuitRejected++;if(request.spans&&request.spans.length<160)request.spans.push({id:++spanId,parentId,service:id,start:round(now),end:round(now),status:'circuit-open',attempt:currentAttempt+1});finishLogical(false,'circuit-open');return;}
    state.circuit='half-open';state.probe=true;
   }
   const isProbe=policy.circuitBreaker&&state.circuit==='half-open',started=now,thisSpan=++spanId;
   const span={id:thisSpan,parentId,service:id,start:round(now),end:round(now),status:'pending',attempt:currentAttempt+1};
   if(request.spans&&request.spans.length<160)request.spans.push(span);state.calls++;
   let ended=false,acquired=false;const children=[],timers=[];
   const later=(delay,fn)=>{const e=schedule(now+delay,fn);timers.push(e);};
   const clearTimers=()=>{for(const e of timers)e.fn=null;timers.length=0;};
   const release=()=>{if(acquired){state.active--;acquired=false;}};
   const endAttempt=(ok,status)=>{
    if(ended||cancelled||settled)return;ended=true;clearTimers();release();children.forEach(cancel=>cancel());span.end=round(now);span.status=status;state.latencies.push(now-started);
    if(ok)state.successes++;else{state.errors++;if(status==='timeout')state.timeouts++;if(status==='overloaded')state.rejected++;}
    if(policy.circuitBreaker){if(ok&&(state.circuit==='closed'||isProbe)){state.consecutive=0;state.probe=false;state.circuit='closed';}else if(!ok){state.consecutive++;if((state.consecutive>=5&&state.circuit==='closed')||isProbe){state.circuit='open';state.openUntil=now+5000;state.probe=false;addEvent('circuit',id,'Circuit opened for 5 seconds');}}}
    if(!ok&&currentAttempt<policy.retries){const cap=policy.backoff*2**currentAttempt,delay=policy.jitter?cap*noise(`${request.id}/${path}/${currentAttempt}/backoff`):cap;pendingRetry=schedule(now+delay,attempt);}else finishLogical(ok,status);
   };
   cancelAttempt=()=>{if(ended)return;ended=true;clearTimers();release();children.forEach(cancel=>cancel());state.cancelled++;span.end=round(now);span.status='cancelled';if(isProbe){state.probe=false;state.circuit='open';state.openUntil=now+5000;}};
   const affected=faultActive(id),capacity=affected&&fault.type==='capacity'?Math.max(1,Math.floor(def.capacity*fault.value/100)):def.capacity;
   if(state.active>=capacity){later(1,()=>endAttempt(false,'overloaded'));return;}
   state.active++;acquired=true;state.peakActive=Math.max(state.peakActive,state.active);later(policy.timeout,()=>endAttempt(false,'timeout'));
   const key=`${request.id}/${path}/${currentAttempt}`,workTime=def.latency*(.75+noise(`${key}/latency`)*.5)+(affected&&fault.type==='latency'?fault.value:0);
   const probability=affected&&fault.type==='errors'?Math.max(def.errorRate,fault.value/100):def.errorRate,down=affected&&fault.type==='outage';
   later(down?Math.min(workTime,10):workTime,()=>{
    if(ended||cancelled||settled)return;if(down||noise(`${key}/error`)<probability){endAttempt(false,down?'unavailable':'error');return;}
    if(!def.dependencies.length){endAttempt(true,'ok');return;}let pending=def.dependencies.length;
    for(const child of def.dependencies){if(ended)break;const cancel=invoke(child,request,ok=>{if(ended)return;if(!ok)endAttempt(false,'dependency-failed');else if(--pending===0)endAttempt(true,'ok');},thisSpan,`${path}/${currentAttempt}/${child}`);children.push(cancel);if(ended)cancel();}
   });
  };attempt();return()=>{if(cancelled||settled)return;cancelled=true;if(pendingRetry)pendingRetry.fn=null;cancelAttempt();};
 }
 const total=config.rps*config.duration,traces=[],outcomes=[],cohort=Array.from({length:config.duration},(_,second)=>({second,latencies:[],total:0,failed:0})),sampleEvery=Math.max(1,Math.ceil(total/60));
 for(let i=0;i<total;i++){const arrival=i*1000/config.rps;schedule(arrival,()=>{const sampled=i<4||i%sampleEvery===0,request={id:i,spans:sampled?[]:null};invoke(config.entry,request,(ok,status)=>{const latency=round(now-arrival);outcomes.push({ok,latency});const bucket=cohort[Math.min(config.duration-1,Math.floor(arrival/1000))];bucket.latencies.push(latency);bucket.total++;if(!ok)bucket.failed++;if(sampled)traces.push({id:`req-${String(i+1).padStart(5,'0')}`,start:round(arrival),duration:latency,ok,status,spans:request.spans});},null,config.entry);});}
 while(queue.items.length){const e=queue.pop();now=e.time;const fn=e.fn;e.fn=null;fn?.();}
 const successful=outcomes.filter(o=>o.ok).length;
 const services=Object.fromEntries([...states].map(([id,s])=>[id,{calls:s.calls,errors:s.errors,retries:s.retries,timeouts:s.timeouts,rejected:s.rejected,cancelled:s.cancelled,circuitRejected:s.circuitRejected,active:s.active,peakActive:s.peakActive,p95:percentile(s.latencies,.95),p50:percentile(s.latencies,.5),errorRate:round(s.errors/Math.max(1,s.calls-s.cancelled)*100)}]));
 const stats=Object.values(services);
 return{summary:{total,successful,failed:total-successful,successRate:round(successful/total*100),p95:percentile(outcomes.map(o=>o.latency),.95),p50:percentile(outcomes.map(o=>o.latency),.5),retries:stats.reduce((n,s)=>n+s.retries,0),attempts:stats.reduce((n,s)=>n+s.calls,0),circuitRejected:stats.reduce((n,s)=>n+s.circuitRejected,0)},services,series:cohort.map(c=>({second:c.second,total:c.total,failed:c.failed,p95:percentile(c.latencies,.95),successRate:round((c.total-c.failed)/Math.max(1,c.total)*100)})),traces:traces.sort((a,b)=>a.start-b.start),events:events.sort((a,b)=>a.time-b.time)};
}
export function runExperiment(config){validateConfig(config);return{engineVersion:ENGINE_VERSION,config:structuredClone(config),baseline:simulate(config,{baseline:true}),experiment:simulate(config)};}
