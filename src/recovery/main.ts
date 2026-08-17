import { pool } from "../db/pool.js";
import { startHeartbeatLoop } from "../runtime/heartbeat.js";
import { config } from "../config.js";
import { runRecoveryWorker } from "./worker.js";

const controller=new AbortController();const stopHeartbeat=startHeartbeatLoop("RECOVERY_WORKER",{policy:"NODE6_2_RECOVERY_POLICY_V1",autoRecovery:config.recoveryAutoEnabled,decoderPath:config.recoveryDecoderPath});
function stop():void{controller.abort();stopHeartbeat();void pool.end();}
process.once("SIGTERM",stop);process.once("SIGINT",stop);
runRecoveryWorker(controller.signal).catch((error)=>{console.error("[RECOVERY_WORKER] fatal",error);process.exitCode=1;}).finally(()=>{stopHeartbeat();void pool.end();});
