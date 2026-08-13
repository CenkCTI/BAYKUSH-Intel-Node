import { describe,expect,it } from "vitest";
import { aggregateComparisonRows } from "../src/measurement/comparison.js";

const row=(numeric:number|null,entity:string|null=null)=>({numeric_value:numeric===null?null:String(numeric),entity_key:entity,source_model_version:null,dimensions:{}});
describe("NODE-4 summary contract",()=>{it("uses LAST_VALUE for CISA catalogue size",()=>expect(aggregateComparisonRows("LAST_VALUE",[row(100),row(105)])).toBe(105));it("uses LAST_VALUE for retained EPSS scored records",()=>expect(aggregateComparisonRows("LAST_VALUE",[row(2400),row(2500)])).toBe(2500));it("aggregates NVD publication events without summing distinct bucket values",()=>expect(aggregateComparisonRows("SUM_EVENTS",[row(1,"cve:a"),row(1,"cve:b")])).toBe(2));it("does not fabricate a scalar for NONE/distribution",()=>expect(aggregateComparisonRows("NONE",[row(12)])).toBeNull());});
