import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import type { Context } from '../types';

export function createValidationMiddleware<T extends z.ZodSchema>(
  schema: T,
  source: 'body' | 'query' | 'params' = 'body',
) {
  return async ({ ctx, next }: { ctx: Context; next: any }) => {
    let data: unknown;

    switch (source) {
      case 'body':
        data = ctx.req?.body;
        break;
      case 'query':
        data = ctx.req?.query;
        break;
      case 'params':
        data = ctx.req?.params;
        break;
      default:
        data = ctx.req?.body;
    }

    try {
      const validated = schema.parse(data);
      return next({
        ctx: {
          ...ctx,
          validatedInput: validated,
        },
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Validation failed',
          cause: error.issues,
        });
      }
      throw error;
    }
  };
}
