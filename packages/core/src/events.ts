import { redis } from './redis.js';

export interface JobEvent {
  jobId: string;
  projectId: string | null;
  type: string;
  status: string;
  progress: number;
  stage?: string | null;
  error?: string | null;
  projectStatus?: string;
}

export const userChannel = (userId: string) => `events:user:${userId}`;

export async function publishJobEvent(userId: string, ev: JobEvent) {
  await redis().publish(userChannel(userId), JSON.stringify(ev));
}
