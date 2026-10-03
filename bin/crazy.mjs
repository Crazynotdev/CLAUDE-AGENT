#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { main } from '../src/cli.mjs';
main(process.argv.slice(2)).catch((e) => { process.stderr.write(`crazy: ${e.message}\n`); process.exitCode = 1; });
