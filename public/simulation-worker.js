import {runExperiment} from './faultline-engine.mjs';
self.onmessage=event=>{try{self.postMessage({ok:true,result:runExperiment(event.data)});}catch(e){self.postMessage({ok:false,error:e instanceof Error?e.message:'Simulation failed.'});}};
