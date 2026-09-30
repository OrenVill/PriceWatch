#!/usr/bin/env node
/**
 * Minimal CLI: pricewatch serve [--mode=catalog|full]
 */
const args = process.argv.slice(2);
const command = args[0];

if (command !== "serve") {
  console.error("Usage: pricewatch serve [--mode=catalog|full]");
  process.exit(1);
}

for (const arg of args.slice(1)) {
  if (arg.startsWith("--mode=")) {
    process.env.PRICEWATCH_MODE = arg.slice("--mode=".length);
  } else {
    console.error(`Unknown argument: ${arg}`);
    process.exit(1);
  }
}

const mode = (process.env.PRICEWATCH_MODE || "full").toLowerCase();
if (mode === "catalog") {
  await import("./catalog-server.js");
} else {
  const { start } = await import("./server.js");
  await start();
}
