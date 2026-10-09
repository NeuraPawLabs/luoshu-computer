import {mkdirSync,cpSync,writeFileSync,existsSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';

if(process.argv.length!==2)throw Error('Usage: package-runtime.mjs');
const root=resolve(import.meta.dirname,'..'),target=join(root,'dist/runtime');
const source=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
const {scripts,devDependencies,...manifest}=source;
manifest.scripts={start:'node dist/main.js'};
manifest.bin={'luoshu-computer':'dist/main.js','luoshu-worker':'dist/runtime/worker-main.js'};
rmSync(target,{recursive:true,force:true});mkdirSync(target,{recursive:true});
function copyCompiledSources(relative=''){
 for(const entry of readdirSync(join(root,'src',relative),{withFileTypes:true})){
  const path=join(relative,entry.name);
  if(entry.isDirectory()){copyCompiledSources(path);continue;}
  if(!entry.isFile()||!entry.name.endsWith('.ts')||entry.name.endsWith('.d.ts'))continue;
  const module=path.slice(0,-3);
  if(!existsSync(join(root,'dist/lib',module+'.js')))throw Error(`Build current source src/${path} first`);
  for(const suffix of ['.js','.js.map','.d.ts','.d.ts.map']){
   const file=join(root,'dist/lib',module+suffix);if(!existsSync(file))continue;
   const output=join(target,'dist',module+suffix);mkdirSync(dirname(output),{recursive:true});cpSync(file,output);
  }
 }
}
copyCompiledSources();
writeFileSync(join(target,'package.json'),JSON.stringify(manifest,null,2)+'\n');
const lock=JSON.parse(readFileSync(join(root,'package-lock.json'),'utf8'));lock.name=manifest.name;lock.version=manifest.version;lock.packages['']=manifest;
writeFileSync(join(target,'package-lock.json'),JSON.stringify(lock,null,2)+'\n');
cpSync(join(root,'LICENSE'),join(target,'LICENSE'));
execFileSync('npm',['install','--package-lock-only','--ignore-scripts','--offline','--no-audit','--no-fund'],{cwd:target,stdio:'pipe',timeout:60_000});
writeFileSync(join(target,'README.txt'),'Luoshu Computer runtime\nNode.js 22+\nRun npm ci --omit=dev, then node dist/main.js setup|daemon|status|doctor.\n');
console.log(target);
