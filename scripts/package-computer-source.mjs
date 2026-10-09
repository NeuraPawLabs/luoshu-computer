import {cpSync,existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve,sep} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createComputerArchive} from './computer-archive.mjs';

const root=resolve(import.meta.dirname,'..');
const args=process.argv.slice(2);
if(args.length && (args.length!==2 || args[0]!=='--output' || !args[1]))throw Error('Usage: package-computer-source.mjs [--output DIR]');
const output=resolve(args[1]??join(root,'dist/computer-source'));
function assertNoSymlinkPath(path){
 const parents=[];let current=resolve(path);
 while(true){parents.push(current);const parent=dirname(current);if(parent===current)break;current=parent;}
 for(const parent of parents.reverse())if(existsSync(parent)&&lstatSync(parent).isSymbolicLink())throw Error(`Computer source paths must not contain a symlink: ${parent}`);
}
assertNoSymlinkPath(root);assertNoSymlinkPath(output);
if(output===root||root.startsWith(output+sep)||output.startsWith(join(root,'apps')+sep)||output.startsWith(join(root,'packages')+sep))throw Error('Unsafe Computer source output directory');
if(existsSync(output)){
 if(existsSync(join(output,'.git')))throw Error('Refusing to replace an existing Git repository');
 if(lstatSync(output).isSymbolicLink())throw Error('Computer source output must not be a symlink');
 if(readdirSync(output).length){
  const marker=join(output,'source-export.json');
  if(!existsSync(marker)||JSON.parse(readFileSync(marker,'utf8')).format!=='luoshu-computer-source-v1')throw Error('Refusing to replace a directory that is not a Computer source export');
 }
}
const workspaces=['packages/protocol','packages/config','apps/worker'];
for(const workspace of workspaces){
 assertNoSymlinkPath(join(root,workspace));assertNoSymlinkPath(join(root,workspace,'src'));
 assertNoSymlinkPath(join(root,workspace,'package.json'));
 if(existsSync(join(root,workspace,'tests')))assertNoSymlinkPath(join(root,workspace,'tests'));
}
assertNoSymlinkPath(join(root,'package.json'));assertNoSymlinkPath(join(root,'package-lock.json'));
const jointTests=[];
const sourcePackage=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
const worker=JSON.parse(readFileSync(join(root,'apps/worker/package.json'),'utf8'));
const tracked=[];
rmSync(output,{recursive:true,force:true});mkdirSync(output,{recursive:true});
function copyFile(path,destination=path){
 const input=join(root,path);
 assertNoSymlinkPath(input);
 if(!lstatSync(input).isFile()||lstatSync(input).isSymbolicLink())throw Error(`Computer source must be a regular file: ${path}`);
 const bytes=readFileSync(input),target=join(output,destination);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,bytes);
 tracked.push({path:destination,sha256:createHash('sha256').update(bytes).digest('hex')});
}
function copySources(directory){
 assertNoSymlinkPath(join(root,directory));
 for(const entry of readdirSync(join(root,directory),{withFileTypes:true})){
  const path=`${directory}/${entry.name}`;
  if(entry.isSymbolicLink())throw Error(`Computer source contains symlink: ${path}`);
  if(entry.isDirectory())copySources(path);
  else if(entry.isFile()&&entry.name.endsWith('.ts')&&!jointTests.includes(path))copyFile(path);
 }
}
const repositoryFacilities=['CONTRIBUTING.md','SECURITY.md','COMPATIBILITY.md','RELEASE.md','.github/workflows/ci.yml','.github/workflows/release.yml'];
for(const workspace of workspaces){
 for(const name of ['package.json','tsconfig.json','LICENSE'])copyFile(`${workspace}/${name}`);
 copySources(`${workspace}/src`);if(existsSync(join(root,workspace,'tests')))copySources(`${workspace}/tests`);
}
for(const file of ['package-runtime.mjs','package-computer.mjs','computer-archive.mjs','computer-release.mjs','computer-node-runtime.mjs','sign-computer-release.mjs','package-computer-source.mjs','prepare-computer-release.mjs','publish-computer-release.mjs','prepare-signed-computer-release.mjs'])copyFile(`scripts/${file}`);
for(const file of ['computer-package.test.mjs','computer-signing.test.mjs','computer-archive.test.mjs','computer-public-release.test.mjs','computer-publish.test.mjs','computer-ci-signing.test.mjs','computer-github-install.test.mjs'])copyFile(`scripts/tests/${file}`);
copyFile('scripts/templates/install-computer.sh');
copyFile('scripts/templates/install-github-computer.sh');
copyFile('release-public-key.pem');
copyFile('scripts/templates/computer-source-readme.md');
copyFile('scripts/templates/computer-source-readme.md','README.md');
for(const file of repositoryFacilities){
 copyFile(`scripts/templates/computer-repository/${file}`);
 copyFile(`scripts/templates/computer-repository/${file}`,file);
}
copyFile('apps/worker/LICENSE','LICENSE');copyFile('tsconfig.base.json');
const json=(name,value)=>writeFileSync(join(output,name),JSON.stringify(value,null,2)+'\n');
const manifest={name:'luoshu-computer-source',version:worker.version,private:true,license:'MIT',type:'module',engines:{node:'>=22'},workspaces,
 scripts:{build:'tsc -b',lint:'tsc -b --pretty false',test:'vitest run',worker:'npm run dev -w @luoshu/worker --',computer:'tsx apps/worker/src/computer-main.ts',package:'node scripts/package-computer.mjs','package:source':'node scripts/package-computer-source.mjs',sign:'node scripts/sign-computer-release.mjs','test:package':'node --test scripts/tests/computer-package.test.mjs scripts/tests/computer-signing.test.mjs scripts/tests/computer-archive.test.mjs scripts/tests/computer-public-release.test.mjs scripts/tests/computer-publish.test.mjs scripts/tests/computer-ci-signing.test.mjs scripts/tests/computer-github-install.test.mjs','release:prepare':'node scripts/prepare-computer-release.mjs','release:prepare:signed':'node scripts/prepare-signed-computer-release.mjs','release:publish':'node scripts/publish-computer-release.mjs'},
 devDependencies:Object.fromEntries(['@types/node','typescript','tsx','vitest'].map(name=>[name,sourcePackage.devDependencies[name]])),allowScripts:{'node-pty@1.1.0':true}};
json('package.json',manifest);json('tsconfig.json',{files:[],references:workspaces.map(path=>({path}))});
writeFileSync(join(output,'vitest.config.ts'),"import {defineConfig} from 'vitest/config';\nexport default defineConfig({test:{include:['apps/worker/tests/**/*.test.ts','packages/*/tests/**/*.test.ts'],testTimeout:15000,hookTimeout:15000,pool:'forks',maxWorkers:2}});\n");
writeFileSync(join(output,'.gitignore'),'node_modules/\ndist/\ncoverage/\n*.tsbuildinfo\n*.sqlite*\n.env*\n');
const lock=JSON.parse(readFileSync(join(root,'package-lock.json'),'utf8'));
lock.name=manifest.name;lock.version=manifest.version;lock.packages['']=manifest;
for(const [path,record] of Object.entries(lock.packages)){
 if((path.startsWith('apps/')||path.startsWith('packages/'))&&!workspaces.includes(path)||record.link&&!workspaces.includes(record.resolved))delete lock.packages[path];
}
for(const workspace of workspaces)lock.packages[workspace]=JSON.parse(readFileSync(join(output,workspace,'package.json'),'utf8'));
json('package-lock.json',lock);
execFileSync('npm',['install','--package-lock-only','--ignore-scripts','--offline','--no-audit','--no-fund'],{cwd:output,stdio:'pipe',timeout:60000});
let upstream;
if(existsSync(join(root,'source-export.json'))){assertNoSymlinkPath(join(root,'source-export.json'));upstream=JSON.parse(readFileSync(join(root,'source-export.json'),'utf8')).upstream;}
else{
 try{
  const commit=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
  const dirty=Boolean(execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim());
  upstream={repository:'https://github.com/NeuraPawLabs/luoshu',commit,dirty};
 }catch{/* A source archive without Git history has only its content hashes. */}
}
json('source-export.json',{format:'luoshu-computer-source-v1',version:worker.version,license:'MIT',workspaces,...(upstream?{upstream}:{}),joint_tests_remaining_in_main:jointTests,files:tracked});
createComputerArchive(output,join(dirname(output),`luoshu-computer-source-${worker.version}.tar.gz`));
console.log(output);
