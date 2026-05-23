import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type WxtViteConfig } from "wxt";

const env = (
  globalThis as unknown as {
    process?: { env?: Record<string, string | undefined> };
  }
).process?.env;
const oauthClientId =
  env?.YOUTUBE_OAUTH_CLIENT_ID ??
  "1082059658861-sj2nijf9sfik53vbi22if8ukak4r0suj.apps.googleusercontent.com";
const extensionKey = env?.CHROME_EXTENSION_KEY;
const firefoxManifestSettings = {
  browser_specific_settings: {
    gecko: {
      id: "subscribed-since@isaac.extensions",
      strict_min_version: "140.0",
      data_collection_permissions: {
        required: ["authenticationInfo"],
      },
    },
  },
};

// See https://wxt.dev/api/config.html
export default defineConfig({
  srcDir: "src",
  outDir: "dist",
  modules: ["@wxt-dev/module-react"],
  manifest: ({ browser }) => ({
    name: "Subscribed Since - YouTube Subscription Dates",
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
    host_permissions: [
      "*://*.youtube.com/*",
      "https://www.googleapis.com/*",
      ...(browser === "firefox" ? ["https://accounts.google.com/*"] : []),
    ],
    ...(browser === "firefox"
      ? {}
      : {
          oauth2: {
            client_id: oauthClientId,
            scopes: ["https://www.googleapis.com/auth/youtube.readonly"],
          },
        }),
    web_accessible_resources: [
      {
        resources: ["page-context-channel.js"],
        matches: ["*://*.youtube.com/*"],
      },
    ],
    ...(browser === "firefox" ? firefoxManifestSettings : {}),
    ...(extensionKey ? { key: extensionKey } : {}),
  }),
  vite: () =>
    ({
      plugins: [tailwindcss()],
      build: {
        minify: false,
      },
    }) as WxtViteConfig,
});
