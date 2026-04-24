#!/usr/bin/env node
import { runCli } from "./cli.ts";

const result = await runCli(process.argv.slice(2));
process.exitCode = result.exitCode;
