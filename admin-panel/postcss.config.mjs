import { fileURLToPath } from "node:url";
import path from "node:path";

// Absolute config path: this file can be loaded with a process.cwd() other
// than admin-panel/ (the embedded custom server in web/nextAdminMiddleware.js
// runs from the repo root), and Next's bundled Tailwind integration resolves
// a bare `tailwindcss: {}` entry against process.cwd(), silently finding no
// config and producing an empty utility set.
const here = path.dirname(fileURLToPath(import.meta.url));

export default {
  plugins: {
    tailwindcss: { config: path.join(here, "tailwind.config.ts") },
    autoprefixer: {},
  },
};
