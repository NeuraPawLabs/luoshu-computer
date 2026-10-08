import {execFileSync} from 'node:child_process';

// Build identity reflects archive contents, not file order, mtimes or host UID.
export function createComputerArchive(staging,archive) {
  execFileSync('tar',['--sort=name','--mtime=@0','--owner=0','--group=0','--numeric-owner','-czf',archive,'-C',staging,'.']);
}
