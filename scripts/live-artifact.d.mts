export declare const LIVE_ARTIFACT_VERSION: number;
export declare const LIVE_ERROR_CLASSES: readonly string[];

export declare function classifyLiveError(error: unknown, status?: number): string;
export declare function redactDeep(value: unknown, depth?: number): unknown;

export interface LiveFailureArtifact {
  artifactVersion: number;
  kind: string;
  provider: string | null;
  model: string | null;
  requestShape: unknown;
  latencyMs: number | null;
  errorClass: string;
  message: string;
  status: number | string | null;
  at: string;
  extra: unknown;
}

export declare function liveFailureArtifact(input?: Record<string, unknown>): LiveFailureArtifact;
