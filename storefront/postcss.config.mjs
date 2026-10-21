import { fileURLToPath } from "node:url";
import path from "node:path";

// Absolute config path so the build works whatever process.cwd() is.
const here = path.dirname(fileURLToPath(import.meta.url));

export default {
  plugins: {
    tailwindcss: { config: path.join(here, "tailwind.config.ts") },
    autoprefixer: {},
  },
};
