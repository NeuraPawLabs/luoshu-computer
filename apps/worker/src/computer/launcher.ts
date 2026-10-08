import {mkdir,rename,rm,writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {ComputerPaths} from './paths.js';

/** CLI commands do not consume a daemon startup attempt. */
export async function updateComputerLauncher(paths:ComputerPaths):Promise<void> {
  const root="'"+paths.root.replaceAll("'","'\\''")+"'";
  const script=`#!/bin/sh\nset -eu\nROOT=${root}\nrollback="\${ROOT}/rollback-version"
attempted="\${ROOT}/update-attempted"
if [ "\${1:-}" = 'daemon' ]; then
  if [ -f "$rollback" ] && [ -f "$attempted" ]; then
    previous=$(cat "$rollback")
    [ -d "$previous" ] && ln -sfn "$previous" "\${ROOT}/current"
    rm -f "$rollback" "$attempted"
  elif [ -f "$rollback" ]; then
    : > "$attempted"
  fi
fi
exec "\${ROOT}/current/runtime/node" "\${ROOT}/current/app/apps/worker/dist/computer-main.js" "$@"
`;
  await mkdir(dirname(paths.executable),{recursive:true,mode:0o700});
  const temporary=paths.executable+'.new-'+randomUUID();
  try{await writeFile(temporary,script,{flag:'wx',mode:0o755});await rename(temporary,paths.executable);}
  finally{await rm(temporary,{force:true});}
}
