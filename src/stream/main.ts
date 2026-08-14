import WebSocket, { type RawData } from "ws";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { startHeartbeatLoop } from "../runtime/heartbeat.js";
import { BoundedStreamQueue } from "./queue.js";
import { RIPE_RIS_LIVE_URL } from "./ripe-ris/source.js";
import { attachCaptureProfile, createStreamSession, ensureCaptureProfile, ensureCoveredMinute, loadRipeSourceState, persistStreamSegment, recordStreamEvent, updateStreamSession } from "./repository.js";

let stopping=false;const stopHeartbeat=startHeartbeatLoop("STREAM_WORKER",{subsystem:"routing-stream",sourceKey:"RIPE_RIS_BGP",schemaVersion:"NODE6_STREAM_V1"});
const sleep=(ms:number)=>new Promise((resolve)=>setTimeout(resolve,ms));

async function runSession(sourceDefinitionId:string):Promise<void>{
  const sessionId=await createStreamSession(sourceDefinitionId,config.instanceId);const queue=new BoundedStreamQueue(config.streamQueueMaxMessages,config.streamQueueMaxBytes);let profileId:string|null=null;let sequence=0;let flushing=false;let subscribed=false;
  const socket=new WebSocket(RIPE_RIS_LIVE_URL,{handshakeTimeout:15000,maxPayload:config.streamMaxMessageBytes,perMessageDeflate:false});
  const flush=async()=>{if(flushing||queue.size===0)return;flushing=true;try{const messages=queue.drain(config.streamSegmentMaxMessages,config.streamSegmentMaxBytes);if(messages.length){await persistStreamSegment({sourceDefinitionId,sessionId,profileId,sequence:sequence++,messages,rawRetentionHours:config.streamRawRetentionHours});}}finally{flushing=false;}};
  const drainTimer=setInterval(()=>void flush().catch(async(error)=>{console.error("stream segment flush failed",error);await recordStreamEvent(sessionId,"DB_UNAVAILABLE",{}).catch(()=>undefined);socket.close(1013,"database unavailable");}),config.streamFlushIntervalMs);
  const zeroTimer=setInterval(()=>{if(subscribed)void ensureCoveredMinute({sourceDefinitionId,profileId,instant:new Date()}).catch((error)=>console.error("covered-minute materialization failed",error));},10000);
  await new Promise<void>((resolve)=>{
    socket.on("open",()=>{void updateStreamSession(sessionId,"CONNECTED");void recordStreamEvent(sessionId,"CONNECTED");socket.send(JSON.stringify({type:"request_rrc_list"}));socket.send(JSON.stringify({type:"ris_subscribe",data:{type:"UPDATE"}}));});
    socket.on("message",(data:RawData)=>{const raw=typeof data==="string"?data:data.toString("utf8");if(Buffer.byteLength(raw)>config.streamMaxMessageBytes){void recordStreamEvent(sessionId,"SCHEMA_REJECTION",{reason:"MESSAGE_TOO_LARGE"});socket.close(1009,"message too large");return;}let controlType:string|null=null;try{const parsed=JSON.parse(raw) as {type?:unknown;data?:unknown};controlType=typeof parsed.type==="string"?parsed.type:null;if(controlType==="ris_rrc_list"&&Array.isArray(parsed.data)){const rrcs=parsed.data.filter((value):value is string=>typeof value==="string");void ensureCaptureProfile(sourceDefinitionId,rrcs).then(async(id)=>{profileId=id;await attachCaptureProfile(sessionId,id);await recordStreamEvent(sessionId,"RRC_LIST_RECEIVED",{rrcCount:rrcs.length});});return;}if(controlType==="ris_subscribe_ok"){subscribed=true;void updateStreamSession(sessionId,"STREAMING");void recordStreamEvent(sessionId,"SUBSCRIBED");return;}if(controlType!=="ris_message")return;}catch{void recordStreamEvent(sessionId,"SCHEMA_REJECTION",{reason:"INVALID_JSON"});return;}const receivedAt=new Date().toISOString();const item={raw,receivedAt,bytes:Buffer.byteLength(raw)};if(!queue.push(item)){void recordStreamEvent(sessionId,"BACKPRESSURE_LIMIT",{queuedMessages:queue.size,queuedBytes:queue.bytes});socket.close(1013,"backpressure");}});
    socket.on("error",(error)=>{console.error("RIPE RIS stream error",error);void recordStreamEvent(sessionId,"PROVIDER_ERROR",{});});
    socket.on("close",()=>resolve());
  });
  clearInterval(drainTimer);clearInterval(zeroTimer);await flush().catch(()=>undefined);await updateStreamSession(sessionId,stopping?"CLOSED":"FAILED",stopping?"shutdown":"stream disconnected");await recordStreamEvent(sessionId,"PROVIDER_DISCONNECT",{}).catch(()=>undefined);
}

async function main():Promise<void>{let attempt=0;while(!stopping){const source=await loadRipeSourceState();if(!source?.enabled){attempt=0;await sleep(config.streamIdleMs);continue;}try{await runSession(source.id);attempt+=1;}catch(error){console.error("stream session failed",error);attempt+=1;}if(!stopping){const delay=Math.min(config.streamReconnectMaxMs,config.streamReconnectBaseMs*2**Math.min(attempt,8));await sleep(delay);}}}
function shutdown(signal:string):void{if(stopping)return;console.log(`stream worker received ${signal}; shutting down`);stopping=true;stopHeartbeat();}
process.once("SIGINT",()=>shutdown("SIGINT"));process.once("SIGTERM",()=>shutdown("SIGTERM"));
await main();await pool.end();
