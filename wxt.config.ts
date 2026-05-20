import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type WxtViteConfig } from "wxt";

const env = (
  globalThis as unknown as {
    process?: { env?: Record<string, string | undefined> };
  }
).process?.env;
const oauthClientId =
  env?.YOUTUBE_OAUTH_CLIENT_ID ??
  "1082059658861-8kmr863dfip3968o8d79k92tner2h910.apps.googleusercontent.com";
const extensionKey = env?.CHROME_EXTENSION_KEY;

// See https://wxt.dev/api/config.html
export default defineConfig({
  srcDir: "src",
  outDir: "dist",
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "Subscribed Since",
    short_name: "Subscribed Since",
    icons: {
      "16": "icon/16.png",
      "32": "icon/32.png",
      "48": "icon/48.png",
      "128": "icon/128.png",
    },
    action: {
      default_icon: {
        "16": "icon/16.png",
        "32": "icon/32.png",
        "48": "icon/48.png",
        "128": "icon/128.png",
      },
    },
    permissions: ["identity", "storage", "alarms"],
    host_permissions: ["*://*.youtube.com/*", "https://www.googleapis.com/*"],
    oauth2: {
      client_id: oauthClientId,
      scopes: ["https://www.googleapis.com/auth/youtube.readonly"],
    },
    web_accessible_resources: [
      {
        resources: ["page-context-channel.js"],
        matches: ["*://*.youtube.com/*"],
      },
    ],
    ...(extensionKey ? { key: extensionKey } : {}),
  },
  vite: () =>
    ({
      plugins: [tailwindcss()],
    }) as WxtViteConfig,
});
