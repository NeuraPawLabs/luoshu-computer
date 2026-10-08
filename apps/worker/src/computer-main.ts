try {
  const { runComputerCli } = await import('./computer/cli.js');
  process.exitCode = await runComputerCli(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Computer command failed');
  process.exitCode = 1;
}
