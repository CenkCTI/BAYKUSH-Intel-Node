import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { aggregateAcceptance, createManualEvidence, REQUIRED_GATES, SCENARIOS, validateManualEvidence } from "../scripts/node8j-evidence.mjs";
const image=`ghcr.io/cenkcti/baykush-intel-node@sha256:${"a".repeat(64)}`;
const manual=(id:string,result="PASS")=>createManualEvidence({scenarioId:id,result,hostId:"oracle-node-prod-01",releaseImage:image,operatorNote:"bounded real-host observation",references:[]});
const fixtures=()=>({expectedImage:image,
  release:{schemaVersion:"NODE8_RELEASE_EVIDENCE_V1",result:"ACCEPTED",accepted:true,image,smokeAccepted:true,runtimeAuditAccepted:true,networkAuditAccepted:true},
  backup:{schemaVersion:"NODE8_BACKUP_GATE_EVIDENCE_V1",accepted:true,durable:true},
  restore:{schemaVersion:"NODE8_RESTORE_ACCEPTANCE_V1",accepted:true,provenanceVerified:true,immutableRevisionGuardsVerified:true},
  operations:{schemaVersion:"NODE8_OPS_SNAPSHOT_V1",status:"HEALTHY",containsSecrets:false},
  resilience:{schemaVersion:"NODE8I_RESILIENCE_ACCEPTANCE_V1",result:"MANUAL_PENDING",automatedAccepted:true},
  preflight:{schemaVersion:"NODE8_ORACLE_HOST_PREFLIGHT_V1",result:"PASS",releaseImage:image},
  citem:{schemaVersion:"CITEM_NODE8_CUTOVER_EVIDENCE_V1",result:"PASS",releaseImage:image,serverToServerHttps:true,nodeTokenServerOnly:true,browserBearerCredentialObserved:false,scopeRestricted:true,realNodeDataObserved:true,unavailabilityExplicitlyDegraded:true,unavailabilityReportedAsZero:false,canonicalMutationPossible:false,authFailureSafe:true,endToEndReadPath:true},
  manual:SCENARIOS.map((id)=>manual(id)),synthetic:true});
describe("NODE8J production acceptance contract",()=>{
  it("defines the machine-readable read-only host preflight contract",()=>{const source=readFileSync("deploy/production/scripts/oracle-host-preflight.sh","utf8");expect(source).toContain("NODE8_ORACLE_HOST_PREFLIGHT_V1");expect(source).toContain("MANUAL_REVIEW");expect(source).toContain("for port in 5432 8080");expect(source).toContain('add "NO_PUBLIC_$port"');expect(source).toContain("docker compose --env-file");expect(source).not.toMatch(/oracle (cli|sdk)/i)});
  it("requires all 21 final real-host gates",()=>expect(REQUIRED_GATES).toHaveLength(21));
  it("keeps absent real-host evidence MANUAL_PENDING",()=>expect(aggregateAcceptance({expectedImage:image,manual:[]})).toMatchObject({result:"MANUAL_PENDING",accepted:false}));
  it("produces ACCEPTED only for a clearly synthetic complete fixture",()=>{const out=aggregateAcceptance(fixtures());expect(out).toMatchObject({result:"ACCEPTED",accepted:true,synthetic:true});expect(out.note).toContain("SYNTHETIC");expect(out.gates).toHaveLength(REQUIRED_GATES.length)});
  it("fails on explicit failed evidence",()=>{const f=fixtures();f.manual=f.manual.map((x)=>x.scenarioId==="VM_RESTART"?manual("VM_RESTART","FAIL"):x);expect(aggregateAcceptance(f)).toMatchObject({result:"FAILED",accepted:false})});
  it("requires CITEM cutover evidence",()=>{const f=fixtures();delete (f as Partial<typeof f>).citem;expect(aggregateAcceptance(f).result).toBe("MANUAL_PENDING")});
  it("requires separate replacement-host restore evidence",()=>{const f=fixtures();delete (f as Partial<typeof f>).restore;expect(aggregateAcceptance(f).result).toBe("MANUAL_PENDING")});
  it("rejects unrecognized scenarios and malformed versions",()=>{const r=manual("VM_RESTART");expect(()=>validateManualEvidence({...r,scenarioId:"ARBITRARY_PASS"})).toThrow(/whitelist/);expect(()=>validateManualEvidence({...r,schemaVersion:"V2"})).toThrow(/schema/)});
  it("rejects credential-like fields and contents",()=>{const r=manual("VM_RESTART");expect(()=>validateManualEvidence({...r,password:"oops"})).toThrow(/secret-bearing/);expect(()=>validateManualEvidence({...r,token:"oops"})).toThrow(/secret-bearing/);expect(()=>validateManualEvidence({...r,operatorNote:"Authorization: Bearer abc.def.ghi"})).toThrow(/credential-like/)});
  it("rejects wrong schemas across consumed stage evidence",()=>{const f=fixtures();f.release={...f.release,schemaVersion:"NODE8_RELEASE_EVIDENCE_V2"};expect(()=>aggregateAcceptance(f)).toThrow(/wrong schema/)});
  it("rejects stale or wrong release digest",()=>expect(()=>validateManualEvidence(manual("VM_RESTART"),{expectedImage:`repo@sha256:${"b".repeat(64)}`})).toThrow(/does not match/));
});
