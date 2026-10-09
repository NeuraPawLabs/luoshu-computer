import { expect, test } from 'vitest';
import { renderSystemdUnit } from '../../src/cli/service.js';
import { setupComputer } from '../../src/cli/setup.js';

const paths = {
  root: '/home/alice/.local/share/luoshu-computer',
  state: '/home/alice/.local/share/luoshu-computer/state',
  versions: '/home/alice/.local/share/luoshu-computer/versions',
  current: '/home/alice/.local/share/luoshu-computer/current',
  executable: '/home/alice/.local/bin/luoshu-computer',
  service: '/home/alice/.config/systemd/user/luoshu-computer.service',
};

test('systemd unit restarts the daemon without root privileges', () => {
  const unit = renderSystemdUnit(paths);
  expect(unit).toContain('ExecStart=/home/alice/.local/bin/luoshu-computer daemon');
  expect(unit).toContain('Restart=always');
  expect(unit).toContain('KillMode=control-group');
  expect(unit).toContain('Environment=PATH=%h/.local/bin:%h/.bun/bin:%h/n/bin:%h/.opencode/bin:/usr/local/bin:/usr/bin:/bin');
  expect(unit).not.toContain('User=root');
});

test('setup registers, discards the code, installs a user service, and starts it', async () => {
  const calls: Array<[string, string[]]> = [];
  const files = new Map<string, string>();
  const result = await setupComputer({
    server: 'https://luoshu.test', code: 'single-use', name: 'desk', maintenanceRoot:'/home/alice/src/luoshu',paths,
    pair: async input => { expect(input).toMatchObject({code:'single-use',maintenanceRoots:['/home/alice/src/luoshu']}); expect(input.developmentRoots).toBeUndefined();return { workerId: 'worker_1', status: 'pending' }; },
    writeFile: async (path, value) => { files.set(path, value); },
    mkdir: async () => undefined,
    chmod: async () => undefined,
    rename: async (from, to) => { files.set(to, files.get(from) ?? ''); files.delete(from); },
    run: async (command, args) => { calls.push([command, args]); },
  });
  expect(result).toMatchObject({ workerId: 'worker_1', status: 'pending', service: 'started' });
  expect([...files.values()].join('\n')).not.toContain('single-use');
  expect(calls).toEqual([
    ['systemctl', ['--user', 'daemon-reload']],
    ['systemctl', ['--user', 'enable', '--now', 'luoshu-computer.service']],
  ]);
});

test('setup passes the configured concurrency capacity to pairing', async () => {
  await setupComputer({
    server: 'https://luoshu.test', code: 'single-use', name: 'desk', capacity: 4, paths,
    pair: async input => { expect(input.capacity).toBe(4); return { workerId: 'worker_1', status: 'pending' }; },
    writeFile: async () => undefined, mkdir: async () => undefined, chmod: async () => undefined,
    rename: async () => undefined, run: async () => undefined,
  });
});

test('setup keeps development and maintenance directories independent',async()=>{
 await setupComputer({server:'https://luoshu.test',code:'single-use',name:'desk',paths,developmentRoots:['/code','/projects'],maintenanceRoot:'/maintenance',
 pair:async input=>{expect(input).toMatchObject({developmentRoots:['/code','/projects'],maintenanceRoots:['/maintenance']});return{workerId:'worker_1',status:'pending'};},
 writeFile:async()=>undefined,mkdir:async()=>undefined,chmod:async()=>undefined,rename:async()=>undefined,run:async()=>undefined});
});

test('setup forwards explicit full access to the Worker registration',async()=>{
 await setupComputer({server:'https://luoshu.test',code:'single-use',name:'dedicated codex',paths,codexSandbox:'danger-full-access',
 pair:async input=>{expect(input.codexSandbox).toBe('danger-full-access');return{workerId:'worker_1',status:'pending'};},
 writeFile:async()=>undefined,mkdir:async()=>undefined,chmod:async()=>undefined,rename:async()=>undefined,run:async()=>undefined});
});

test('setup reads a pinned public key before pairing and forwards its PEM rather than its path',async()=>{
 const {generateKeyPairSync}=await import('node:crypto');const {mkdtemp,writeFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const root=await mkdtemp(join(tmpdir(),'release-setup-'));try{
  const key=generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'pem'}).toString(),keyPath=join(root,'public.pem');await writeFile(keyPath,key);
  await setupComputer({server:'https://luoshu.test',code:'single-use',name:'desk',paths,releaseUrl:'https://downloads.test/computer',releaseKey:keyPath,
   pair:async input=>{expect(input).toMatchObject({releaseUrl:'https://downloads.test/computer',releasePublicKey:key});return{workerId:'worker_1',status:'pending'};},
   writeFile:async()=>undefined,mkdir:async()=>undefined,chmod:async()=>undefined,rename:async()=>undefined,run:async()=>undefined});
 }finally{await rm(root,{recursive:true,force:true});}
});

test('setup rejects incomplete or invalid independent source configuration before pairing',async()=>{
 let paired=false;const options={server:'https://luoshu.test',code:'single-use',name:'desk',paths,pair:async()=>{paired=true;return{workerId:'worker_1',status:'pending'};},writeFile:async()=>undefined,mkdir:async()=>undefined,chmod:async()=>undefined,rename:async()=>undefined,run:async()=>undefined};
 await expect(setupComputer({...options,releaseUrl:'https://downloads.test/computer'})).rejects.toThrow(/together|key/i);
 expect(paired).toBe(false);
});

test('setup persists the installer-pinned GitHub source without adding user-facing setup flags',async()=>{
 const {mkdtemp,writeFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {generateKeyPairSync}=await import('node:crypto');
 const root=await mkdtemp(join(tmpdir(),'github-setup-'));try{
  const publicKey=generateKeyPairSync('ed25519').publicKey.export({format:'pem',type:'spki'}).toString();await writeFile(join(root,'release-source.json'),JSON.stringify({repository:'NeuraPawLabs/luoshu-computer',public_key:publicKey}));
  await setupComputer({server:'https://core.test',code:'single-use',name:'desk',paths:{...paths,root},pair:async input=>{expect(input).toMatchObject({releaseRepository:'NeuraPawLabs/luoshu-computer',releasePublicKey:publicKey});return{workerId:'worker_1',status:'pending'};},writeFile:async()=>undefined,mkdir:async()=>undefined,chmod:async()=>undefined,rename:async()=>undefined,run:async()=>undefined});
 }finally{await rm(root,{recursive:true,force:true});}
});
