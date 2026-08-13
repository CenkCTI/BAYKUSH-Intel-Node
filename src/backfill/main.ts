import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { startHeartbeatLoop } from "../runtime/heartbeat.js";
import { backfillTick } from "./runtime.js";

const stop=startHeartbeatLoop('BACKFILL',{concurrency:1});let stopped=false;async function run(){while(!stopped){const worked=await backfillTick();if(!worked)await new Promise(resolve=>setTimeout(resolve,config.workerIdleMs));}}void run().catch(error=>{console.error('BACKFILL runtime failed',error);process.exitCode=1;});async function shutdown(){stopped=true;stop();await pool.end();}process.once('SIGINT',()=>void shutdown());process.once('SIGTERM',()=>void shutdown());
