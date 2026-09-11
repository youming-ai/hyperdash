import type { AuthContext } from '@hyperdash/contracts';
import type { inferAsyncReturnType } from '@trpc/server';
import type { CreateExpressContextOptions } from '@trpc/server/adapters/express';
import jwt from 'jsonwebtoken';

export interface ContextShape {
  user: AuthContext | null;
  req?: CreateExpressContextOptions['req'];
}

export type Context = inferAsyncReturnType<typeof createContext>;

export async function createContext(opts?: CreateExpressContextOptions): Promise<ContextShape> {
  async function getUserFromHeader(): Promise<AuthContext | null> {
    if (opts?.req.headers.authorization) {
      try {
        const token = opts.req.headers.authorization.split(' ')[1];
        const secret = process.env.JWT_SECRET;
        if (!secret) return null;
        const decoded = jwt.verify(token, secret) as Partial<AuthContext>;
        if (!decoded || typeof decoded !== 'object') return null;
        return decoded as AuthContext;
      } catch {
        return null;
      }
    }
    return null;
  }

  const user = await getUserFromHeader();

  return {
    user,
    req: opts?.req,
  };
}
