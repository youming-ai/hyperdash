import { createRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';

export function getRouter() {
  const router = createRouter({
    routeTree,
    defaultPreload: 'intent',
    scrollRestoration: true,
    defaultStructuralSharing: true,
    defaultPreloadStaleTime: 0,
  });

  return router;
}

// Register the router type for global type-safety. Derive it from a concrete
// instance (a value) rather than `ReturnType<typeof getRouter>`.
const registeredRouter = getRouter();
type RegisteredRouter = typeof registeredRouter;

declare module '@tanstack/react-router' {
  interface Register {
    router: RegisteredRouter;
  }
}
