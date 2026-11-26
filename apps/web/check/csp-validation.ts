import { config } from "zod/v4/core";

// The fixtures keep a strict CSP. Firefox reports the generated-function probe even when caught.
config({ jitless: true });
