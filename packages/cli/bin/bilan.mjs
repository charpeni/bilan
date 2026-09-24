#!/usr/bin/env node
import { main } from '../dist/cli.js';

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`bilan: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
