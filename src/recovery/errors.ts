import type { RecoveryFailureCode } from "./policy.js";

export class RecoveryFailure extends Error {
  readonly code: RecoveryFailureCode;
  override readonly cause?: unknown;
  constructor(code: RecoveryFailureCode, message: string, cause?: unknown) {
    super(message); this.name="RecoveryFailure"; this.code=code;
    if(cause!==undefined)this.cause=cause;
  }
}
export function recoveryFailure(code: RecoveryFailureCode, message: string, cause?: unknown): RecoveryFailure { return new RecoveryFailure(code,message,cause); }
