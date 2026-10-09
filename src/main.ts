#!/usr/bin/env node
try {
  const { runComputerCli } = await import('./cli/index.js');
  process.exitCode = await runComputerCli(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Computer command failed');
  process.exitCode = 1;
}
