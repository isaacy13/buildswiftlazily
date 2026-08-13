import { randomUUID } from "node:crypto";
import { redact } from "./security.js";

export type JobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type DeployJob = {
  id: string;
  engine: "local" | "actions";
  status: JobStatus;
  repository: string;
  ref: string;
  scheme: string;
  deployMode: string;
  platform?: "ios" | "watchos";
  logs: string[];
  installUrl?: string;
  itmsUrl?: string;
  testflightNote?: string;
  actionsRunUrl?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
};

export function isLiveJobStatus(status: JobStatus | string | undefined): boolean {
  return status === "queued" || status === "running";
}

export class JobStore {
  private jobs = new Map<string, DeployJob>();
  private order: string[] = [];

  create(
    partial: Omit<DeployJob, "id" | "status" | "logs" | "createdAt" | "updatedAt"> & {
      status?: JobStatus;
    },
  ): DeployJob {
    const now = new Date().toISOString();
    const job: DeployJob = {
      id: randomUUID(),
      status: partial.status || "queued",
      logs: [],
      createdAt: now,
      updatedAt: now,
      ...partial,
    };
    this.jobs.set(job.id, job);
    this.order.unshift(job.id);
    if (this.order.length > 50) {
      const drop = this.order.pop();
      if (drop) this.jobs.delete(drop);
    }
    return job;
  }

  get(id: string): DeployJob | undefined {
    return this.jobs.get(id);
  }

  list(limit = 20): DeployJob[] {
    return this.order.slice(0, limit).map((id) => this.jobs.get(id)!).filter(Boolean);
  }

  /** Most recent queued/running job, if any (for PWA reattach after refresh). */
  findLive(): DeployJob | undefined {
    for (const id of this.order) {
      const job = this.jobs.get(id);
      if (job && isLiveJobStatus(job.status)) return job;
    }
    return undefined;
  }

  appendLog(id: string, line: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.logs.push(redact(line));
    if (job.logs.length > 400) job.logs.splice(0, job.logs.length - 400);
    job.updatedAt = new Date().toISOString();
  }

  patch(id: string, patch: Partial<DeployJob>): DeployJob | undefined {
    const job = this.jobs.get(id);
    if (!job) return;
    const safe = { ...patch };
    if (typeof safe.error === "string") safe.error = redact(safe.error);
    Object.assign(job, safe, { updatedAt: new Date().toISOString() });
    return job;
  }
}

export const globalJobs = new JobStore();
