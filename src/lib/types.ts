/** Tipos compartidos entre el Worker y la interfaz. */

export type ConnMode = "plain" | "starttls" | "implicit";

export type AuthMechanism = "auto" | "login" | "plain" | "cram-md5";

export type LogKind = "info" | "ok" | "warn" | "fail" | "trace" | "hint" | "head";

export interface LogLine {
  kind: LogKind;
  text: string;
}

export interface Fact {
  key: string;
  value: string;
}

export interface ProbeRequest {
  host: string;
  port: number;
  mode: ConnMode;
  helo?: string;
  timeoutSec?: number;

  useAuth: boolean;
  user?: string;
  pass?: string;
  domain?: string;
  auth?: AuthMechanism;

  send?: boolean;
  from?: string;
  to?: string;
  subject?: string;
  body?: string;
}

export interface ProbeResponse {
  ok: boolean;
  title: string;
  detail: string;
  phase: string;
  elapsedMs: number;
  facts: Fact[];
  log: LogLine[];
  code: string;
}

export interface SweepRequest {
  host: string;
  ports: number[];
  timeoutSec?: number;
}

export interface SweepPortResult {
  port: number;
  open: boolean;
  ms: number;
  banner?: string;
  error?: string;
}

export interface SweepResponse {
  ok: boolean;
  host: string;
  results: SweepPortResult[];
  elapsedMs: number;
}
