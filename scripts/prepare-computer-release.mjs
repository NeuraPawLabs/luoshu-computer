import {createHash,createPrivateKey,sign} from 'node:crypto';
import {existsSync,lstatSync,mkdtempSync,mkdirSync,readFileSync,readdirSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve,sep} from 'node:path';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {validateComputerRelease} from './computer-release.mjs';

const root=resolve(import.meta.dirname,'..');
const options={};
const args=process.argv.slice(2);
for(let index=0;index<args.length;index+=2){
 const name=args[index];
 if(!['--output','--key'].includes(name)||!args[index+1]||args[index+1].startsWith('--')||Object.hasOwn(options,name))throw Error('Usage: prepare-computer-release.mjs [--output DIR] [--key FILE]');
 options[name]=args[index+1];
}
const output=resolve(options['--output']??join(root,'dist/release-bundle'));
const within=(path,parent)=>path===parent||path.startsWith(parent+sep);
function assertNoSymlinkPath(path){
 for(let current=path;;current=dirname(current)){
  if(existsSync(current)&&lstatSync(current).isSymbolicLink())throw Error('Release paths must not contain symlinks');
  if(dirname(current)===current)break;
 }
}
assertNoSymlinkPath(root);assertNoSymlinkPath(output);
if(within(root,output)||['apps','packages','.git','scripts','.github'].some(path=>within(output,join(root,path))))throw Error('Unsafe release output directory: keep output outside source and Git directories');
if(['computer','worker','.computer-staging'].some(path=>within(output,join(root,'dist',path))||within(join(root,'dist',path),output)))throw Error('Unsafe release output overlaps a build or package directory');
if(existsSync(output)&&(!lstatSync(output).isDirectory()||existsSync(join(output,'.git'))))throw Error('Release output must be a directory without Git metadata');
let signingKey;
if(options['--key']){
 const keyPath=realpathSync(resolve(options['--key']));
 if(within(keyPath,root)||within(keyPath,output))throw Error('Keep the private signing key external: outside the repository and public output directory');
 signingKey=createPrivateKey(readFileSync(keyPath));
 if(signingKey.asymmetricKeyType!=='ed25519')throw Error('Computer signing key must use Ed25519');
}
const git=(...arguments_)=>execFileSync('git',arguments_,{cwd:root,maxBuffer:128*1024*1024});
if(realpathSync(git('rev-parse','--show-toplevel').toString().trim())!==realpathSync(root))throw Error('Release source must be an independent Git repository root');
if(git('status','--porcelain=v1','--untracked-files=all').length)throw Error('Release requires a clean Git tree, including untracked source files');
const commit=git('rev-parse','HEAD').toString().trim();
const worker=JSON.parse(git('show','HEAD:apps/worker/package.json'));
const sourcePackage=JSON.parse(git('show','HEAD:package.json'));
const version=worker.version;
if(!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)||sourcePackage.version!==version)throw Error('Independent root and Worker package versions must match');
const tag=`v${version}`;
let tagCommit;
try{tagCommit=git('rev-parse',`refs/tags/${tag}^{commit}`).toString().trim();}catch{throw Error(`Release requires the exact version tag ${tag} at HEAD`);}
if(tagCommit!==commit)throw Error(`Version tag ${tag} must point at HEAD`);

// Fail closed on repositories that still contain private monorepo material.
// Only the independently exported Computer source and repository facilities ship.
const rootFiles=new Set(['.gitignore','LICENSE','README.md','CONTRIBUTING.md','SECURITY.md','COMPATIBILITY.md','RELEASING.md','RELEASE.md','package.json','package-lock.json','tsconfig.json','tsconfig.base.json','vitest.config.ts','source-export.json','release-public-key.pem']);
const scripts=new Set(['package-runtime.mjs','package-computer.mjs','computer-archive.mjs','computer-release.mjs','computer-node-runtime.mjs','sign-computer-release.mjs','package-computer-source.mjs','prepare-computer-release.mjs','publish-computer-release.mjs','prepare-signed-computer-release.mjs']);
const tests=new Set(['computer-public-release.test.mjs','computer-source.test.mjs','computer-package.test.mjs','computer-signing.test.mjs','computer-archive.test.mjs','computer-publish.test.mjs','computer-github-install.test.mjs','computer-ci-signing.test.mjs']);
function publicPath(path){
 if(rootFiles.has(path))return true;
 const parts=path.split('/');
 if(parts.length===2&&parts[0]==='scripts')return scripts.has(parts[1]);
 if(parts.length===3&&parts[0]==='scripts'&&parts[1]==='tests')return tests.has(parts[2]);
 if(['scripts/templates/install-computer.sh','scripts/templates/install-github-computer.sh','scripts/templates/computer-source-readme.md'].includes(path))return true;
 if(/^scripts\/templates\/computer-repository\/(?:README|CONTRIBUTING|SECURITY|COMPATIBILITY|RELEASING|RELEASE)\.md$/.test(path))return true;
 if(/^(?:\.github\/workflows|scripts\/templates\/computer-repository\/\.github\/workflows)\/[a-zA-Z0-9_-]+\.ya?ml$/.test(path))return true;
 if(/^(?:apps\/worker|packages\/(?:protocol|config))\/(?:package\.json|tsconfig\.json|LICENSE)$/.test(path))return true;
 return /^(?:apps\/worker|packages\/(?:protocol|config))\/(?:src|tests)\/(?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+\.ts$/.test(path)&&!['apps/worker/tests/assistant-engine-runtime.test.ts','apps/worker/tests/native-capacity-integration.test.ts'].includes(path);
}
const tree=git('ls-tree','-r','-z',commit).toString().split('\0').filter(Boolean);
let license,provenance;
const sourceFiles=[];
for(const entry of tree){
 const [header,path]=entry.split('\t');const [mode,type,hash]=header.split(' ');
 if(!path||!publicPath(path)||!['100644','100755'].includes(mode)||type!=='blob')throw Error(`Tracked source is outside the public Computer whitelist: ${path??entry}`);
 const bytes=git('cat-file','blob',hash);
 if(/^-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----\r?$/m.test(bytes.toString()))throw Error(`Tracked source contains private signing key material: ${path}`);
 if(path==='LICENSE')license=bytes.toString();
 if(path==='source-export.json')provenance=JSON.parse(bytes.toString());
 sourceFiles.push({path,bytes,mode:Number.parseInt(mode,8)&0o777});
}
if(!license||!/^MIT License\b/m.test(license)||!license.includes('Permission is hereby granted, free of charge'))throw Error('Public source requires its tracked MIT LICENSE');
if(provenance?.format!=='luoshu-computer-source-v1'||!/^[a-f0-9]{40}$/.test(provenance?.upstream?.commit??'')||provenance.upstream.dirty===true)throw Error('Tracked source-export.json provenance must identify a clean upstream commit');
const binaryName=`luoshu-computer-${version}-linux-x64.tar.gz`;
const sourceName=`luoshu-computer-source-${version}.tar.gz`;
const allowedOutput=new Set([binaryName,sourceName,'install.sh','manifest.json','manifest.sig','SHA256SUMS','release.json','release-notes.md']);
if(existsSync(output)&&readdirSync(output).length){
 const marker=join(output,'release.json');
 if(!existsSync(marker)||readdirSync(output).some(name=>!allowedOutput.has(name)||!lstatSync(join(output,name)).isFile()||lstatSync(join(output,name)).isSymbolicLink()))throw Error('Refusing to replace a nonempty directory that is not a release output');
 const previous=JSON.parse(readFileSync(marker,'utf8'));
 if(previous.version!==version||!['none','ed25519'].includes(previous.signature)||!Array.isArray(previous.artifacts))throw Error('Refusing to replace an unrelated release output directory');
}
function assertSourceUnchanged(){
 if(git('status','--porcelain=v1','--untracked-files=all').length||git('rev-parse','HEAD').toString().trim()!==commit||git('rev-parse',`refs/tags/${tag}^{commit}`).toString().trim()!==commit)throw Error('Git tree or tag changed during release preparation');
 // Git status can hide edits via assume-unchanged or skip-worktree. Build only
 // exact validated blobs, including executable mode and every ancestor path.
 for(const file of sourceFiles){
  const path=join(root,file.path);assertNoSymlinkPath(path);
  const stat=lstatSync(path);
  if(!stat.isFile()||Boolean(stat.mode&0o111)!==Boolean(file.mode&0o111)||!readFileSync(path).equals(file.bytes))throw Error(`Tracked source changed from the tagged Git snapshot: ${file.path}`);
 }
}
assertSourceUnchanged();
// Force TypeScript to rebuild rather than trust previous incremental outputs.
// Packaging then replaces the same-version binary with this source's build.
execFileSync('npm',['run','build','--','--force'],{cwd:root,stdio:'pipe',timeout:120_000,maxBuffer:16*1024*1024});
assertSourceUnchanged();
execFileSync('npm',['run','package'],{cwd:root,stdio:'pipe',timeout:180_000,maxBuffer:16*1024*1024});
assertSourceUnchanged();
const mirror=validateComputerRelease(join(root,'dist/computer'));
if(mirror.manifest.version!==version)throw Error('Freshly packaged Computer manifest version must match the tagged source');
if(Object.keys(mirror.manifest.releases).length!==1||!mirror.manifest.releases['linux-x64'])throw Error('Release preparation supports Linux x64 only');
const manifest=mirror.files.find(file=>file.path==='manifest.json').bytes;
const archivePath=mirror.manifest.releases['linux-x64'].path.slice('/computer/'.length);
const archive=mirror.files.find(file=>file.path===archivePath).bytes;
// Snapshot the Git blobs ourselves: git archive honors local export-ignore and
// export-subst attributes, which would violate the exact tracked-byte contract.
const staging=mkdtempSync(join(tmpdir(),'luoshu-computer-release-source-'));
let sourceArchive;
try{
 const prefix=`luoshu-computer-${version}`;
 for(const file of sourceFiles){
  const destination=join(staging,prefix,file.path);
  mkdirSync(dirname(destination),{recursive:true});writeFileSync(destination,file.bytes,{mode:file.mode});
 }
 sourceArchive=execFileSync('tar',['--sort=name','--mtime=@0','--owner=0','--group=0','--numeric-owner','-czf','-','-C',staging,prefix],{maxBuffer:128*1024*1024});
}finally{rmSync(staging,{recursive:true,force:true});}
const artifacts=[
 {name:sourceName,bytes:sourceArchive,mode:0o644},
 {name:binaryName,bytes:archive,mode:0o644},
 {name:'install.sh',bytes:sourceFiles.find(file=>file.path==='scripts/templates/install-github-computer.sh')?.bytes??mirror.files.find(file=>file.path==='install.sh').bytes,mode:0o755},
 {name:'manifest.json',bytes:manifest,mode:0o644},
];
if(signingKey)artifacts.push({name:'manifest.sig',bytes:sign(null,manifest,signingKey),mode:0o644});
const release={version,tag,commit,protocol_version:mirror.manifest.protocol_version,prerelease:!signingKey,signature:signingKey?'ed25519':'none',artifacts:artifacts.map(({name,bytes})=>({name,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}))};
const notes=`# Luoshu Computer ${version}\n\nLinux x64; Node.js 22+; protocol v${release.protocol_version}.\n\nSource: tag ${tag}, independent repository commit ${commit}. The source archive contains exactly the tracked public source at this commit, including source-export.json upstream provenance, with no Git history.\n\n${signingKey?'The original manifest bytes are signed with the supplied external Ed25519 key.':'Unsigned prerelease: no signing key was supplied. This bundle is not an authenticated automatic update source.'}\n\nThe GitHub bootstrap installer and GitHub-configured Computer clients verify the signed manifest using their pinned public key and follow only official GitHub asset redirects. Unsigned bundles are not accepted by these clients. The install.sh attachment is the pinned GitHub bootstrap installer. Custom static feeds use the original layout from dist/computer, with a matching manifest.sig and the archive at ${mirror.manifest.releases['linux-x64'].path}. Pin the trusted signing public key for a signed feed.\n\nCheck SHA256SUMS before installation. No repository creation, publication, or service changes are performed by this command.\n`;
// All validation and artifact construction precedes writes. Only a recognized
// stale signature is removed; Git metadata and unrelated files are never deleted.
assertSourceUnchanged();
mkdirSync(output,{recursive:true});
for(const artifact of artifacts)writeFileSync(join(output,artifact.name),artifact.bytes,{mode:artifact.mode});
if(!signingKey)rmSync(join(output,'manifest.sig'),{force:true});
writeFileSync(join(output,'SHA256SUMS'),release.artifacts.map(artifact=>`${artifact.sha256}  ${artifact.name}\n`).join(''));
writeFileSync(join(output,'release-notes.md'),notes);
writeFileSync(join(output,'release.json'),JSON.stringify(release,null,2)+'\n');
console.log(output);
