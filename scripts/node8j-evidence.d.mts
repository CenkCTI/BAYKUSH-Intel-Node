export const SCENARIOS: readonly string[];
export const SEMANTIC_INVARIANTS: readonly string[];
export const REQUIRED_GATES: readonly string[];
export type ManualEvidence={schemaVersion:string;scenarioId:string;result:string;observedAt:string;operatorNote:string;hostId:string;releaseImage:string;references:Array<{name:string;sha256:string}>;containsSecrets:boolean};
export function assertNoSecrets(value:unknown,path?:string):void;
export function readJson(path:string):unknown;
export function validateManualEvidence(value:unknown,options?:{expectedImage?:string}):ManualEvidence;
export function createManualEvidence(input:{scenarioId:string;result:string;observedAt?:string;operatorNote?:string;hostId:string;releaseImage:string;references?:Array<{name:string;sha256:string}>}):ManualEvidence;
export function aggregateAcceptance(input:{expectedImage:string;release?:unknown;backup?:unknown;restore?:unknown;operations?:unknown;resilience?:unknown;preflight?:unknown;citem?:unknown;manual?:ManualEvidence[];synthetic?:boolean}):{schemaVersion:string;result:string;accepted:boolean;synthetic:boolean;note:string;gates:Array<{id:string;status:string}>};
