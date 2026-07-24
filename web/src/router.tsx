import {
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
} from "@tanstack/react-router";
import { App } from "./App";
import {
  tabToPath,
  validateAppSearch,
  validateIndexSearch,
} from "./lib/app-search";

// App is rendered by the ROOT route so it stays mounted across every page
// change — the page is selected by the URL path (read inside App via
// useRouterState), not by swapping route components. Remounting the ~16k-line
// App on each tab switch would blow away sessions, live streams and scroll, so
// the child routes below exist only to make each path a valid match (and to
// hold per-route search validation); they render nothing themselves.
const rootRoute = createRootRoute({
  component: App,
});

// `/` → the default page ("live"). Also honors a legacy `?tab=` param by
// redirecting to the matching path, so old links and bookmarks keep working.
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  validateSearch: validateIndexSearch,
  beforeLoad: ({ search }) => {
    if (search.tab) {
      throw redirect({
        to: tabToPath(search.tab),
        search: search.session ? { session: search.session } : {},
        replace: true,
      });
    }
  },
  component: () => null,
});

// `/$tab` → any single-segment page: a built-in page or an extension tab id.
const tabRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "$tab",
  validateSearch: validateAppSearch,
  component: () => null,
});

const routeTree = rootRoute.addChildren([indexRoute, tabRoute]);

export const router = createRouter({
  routeTree,
  defaultPreload: false,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
