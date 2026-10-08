import {readFileSync,readdirSync,lstatSync,realpathSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';

const args=process.argv.slice(2);
if(args.length!==2||args[0]!=='--bundle'||!args[1])throw Error('Usage: publish-computer-release.mjs --bundle DIR (GH_REPO=owner/repository)');
const bundle=resolve(args[1]),repo=process.env.GH_REPO;
if(!repo||!/^[-A-Za-z0-9_.]+\/[-A-Za-z0-9_.]+$/.test(repo))throw Error('Set GH_REPO to the exact public Computer repository');
if(lstatSync(bundle).isSymbolicLink()||!lstatSync(bundle).isDirectory()||realpathSync(bundle)!==bundle)throw Error('Release bundle paths must not contain symlinks');
function read(name){
 if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name))throw Error('Unsafe release artifact name');
 const path=join(bundle,name),stat=lstatSync(path);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)throw Error('Release artifacts must be regular files');
 return readFileSync(path);
}
const release=JSON.parse(read('release.json'));
if(!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(release.version)||release.tag!==`v${release.version}`||!/^[a-f0-9]{40,64}$/.test(release.commit)||!Number.isInteger(release.protocol_version))throw Error('Invalid release identity');
if(!['none','ed25519'].includes(release.signature)||typeof release.prerelease!=='boolean'||release.signature==='none'&&!release.prerelease)throw Error('Unsigned releases must be prereleases');
if(!Array.isArray(release.artifacts)||!release.artifacts.length||release.artifacts.length>8)throw Error('Invalid release artifact list');
const uploads=[],checksums=[],allowed=new Set(['release.json','SHA256SUMS','release-notes.md']);
const payloadNames=new Set([`luoshu-computer-source-${release.version}.tar.gz`,`luoshu-computer-${release.version}-linux-x64.tar.gz`,'install.sh','manifest.json',...(release.signature==='ed25519'?['manifest.sig']:[])]);
for(const artifact of release.artifacts){
 if(!payloadNames.has(artifact.name)||allowed.has(artifact.name)||!Number.isInteger(artifact.size)||artifact.size<1||!/^[a-f0-9]{64}$/.test(artifact.sha256))throw Error('Invalid release artifact metadata');
 const bytes=read(artifact.name);
 if(bytes.length!==artifact.size||createHash('sha256').update(bytes).digest('hex')!==artifact.sha256)throw Error('Release artifact digest or size mismatch');
 allowed.add(artifact.name);uploads.push(join(bundle,artifact.name));checksums.push(`${artifact.sha256}  ${artifact.name}`);
}
if(release.artifacts.length!==payloadNames.size)throw Error('Release bundle is missing required payload artifacts');
if(readdirSync(bundle).some(name=>!allowed.has(name)))throw Error('Unlisted files in release bundle');
const actualSums=read('SHA256SUMS').toString('utf8').trim().split('\n').sort();
if(JSON.stringify(actualSums)!==JSON.stringify(checksums.sort()))throw Error('Release checksums differ from artifact metadata');
read('release-notes.md');
const gh=(args)=>execFileSync(process.env.LUOSHU_GH_BIN??'gh',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']});
gh(['auth','status','--hostname','github.com']);
const repository=JSON.parse(gh(['api',`repos/${repo}`]));
if(repository.full_name!==repo||repository.private!==false||repository.permissions?.push!==true)throw Error('GitHub repository must be the selected public writable repository');
let ref=JSON.parse(gh(['api',`repos/${repo}/git/ref/tags/${release.tag}`])).object;
if(ref?.type==='tag')ref=JSON.parse(gh(['api',`repos/${repo}/git/tags/${ref.sha}`])).object;
if(ref?.type!=='commit'||ref.sha!==release.commit)throw Error('Remote release tag does not match the prepared source commit');
try{gh(['release','view',release.tag,'--repo',repo,'--json','id']);throw Error('Release already exists; refusing to replace published artifacts');}
catch(error){if(error.message==='Release already exists; refusing to replace published artifacts')throw error;}
const command=['release','create',release.tag,'--repo',repo,'--verify-tag','--target',release.commit,'--title',`Luoshu Computer ${release.version}`,'--notes-file',join(bundle,'release-notes.md'),'--latest=false'];
if(release.prerelease)command.push('--prerelease');
command.push(...uploads,join(bundle,'release.json'),join(bundle,'SHA256SUMS'));
process.stdout.write(gh(command));
