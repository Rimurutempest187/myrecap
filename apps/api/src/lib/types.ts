import type { User, Plan } from '@recap/core';

export type AuthUser = User & { plan: Plan | null };

export type AppEnv = {
  Variables: {
    user: AuthUser;
    sessionId: string;
    requestId: string;
  };
};
