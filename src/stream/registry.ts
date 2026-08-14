import { ripeRisSourceDefinition } from "./ripe-ris/source.js";
export const streamSourceDefinitions=Object.freeze([ripeRisSourceDefinition]);
export const streamSourceKeys=Object.freeze(streamSourceDefinitions.map((definition)=>definition.sourceKey));
