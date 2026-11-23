import { beforeEach } from "vite-plus/test";
import { commands } from "vite-plus/test/browser";

import { initializeI18n } from "../src/i18n/initializeI18n";

declare module "vite-plus/test/browser" {
  interface BrowserCommands {
    /** Defined in vite.config.ts. Moves Playwright's mouse off the page. */
    resetPointer: () => Promise<void>;
  }
}

// Browser test files share one origin's localStorage, and the composer draft store hydrates from
// it at import, so a draft one file leaves behind shows up as a row in the next file's sidebar.
// This setup runs before that import, and the key is composerDraftStore's COMPOSER_DRAFT_STORAGE_KEY.
localStorage.removeItem("t3code:composer-drafts:v1");

// Playwright's mouse outlives each test and each file, so whatever the next test mounts
// under its last position starts hovered. Registered here rather than in render() so tests
// that mount without it are covered too. Before each test, not after: a timed-out test keeps
// running and can move the mouse after its own afterEach.
beforeEach(async () => {
  await commands.resetPointer();
});

// The app initializes GT at startup; components using its hooks need the same here.
initializeI18n(() => {});
