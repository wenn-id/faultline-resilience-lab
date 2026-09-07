export type Service={id:string;name:string;kind:'gateway'|'service'|'database'|'cache'|'external';latency:number;capacity:number;errorRate:number;dependencies:string[]};
export type Config={version:1;name:string;seed:number;entry:string;rps:number;duration:number;services:Service[];policy:{timeout:number;retries:number;backoff:number;jitter:boolean;circuitBreaker:boolean};fault:{enabled:boolean;target:string;type:'latency'|'errors'|'outage'|'capacity';value:number;start:number;duration:number}};
export type Summary={total:number;successful:number;failed:number;successRate:number;p95:number;p50:number;retries:number;attempts:number;circuitRejected:number};
export type Stats={calls:number;errors:number;retries:number;timeouts:number;rejected:number;cancelled:number;circuitRejected:number;active:number;peakActive:number;p95:number;p50:number;errorRate:number};
export type Trace={id:string;start:number;duration:number;ok:boolean;status:string;spans:{id:number;parentId:number|null;service:string;start:number;end:number;status:string;attempt:number}[]};
export type Simulation={summary:Summary;services:Record<string,Stats>;series:{second:number;total:number;failed:number;p95:number;successRate:number}[];traces:Trace[];events:{time:number;kind:string;service:string;message:string}[]};
export type Result={engineVersion:string;config:Config;baseline:Simulation;experiment:Simulation};
export type Saved={id:string;name:string;savedAt:string;config:Config;summary:Summary};
