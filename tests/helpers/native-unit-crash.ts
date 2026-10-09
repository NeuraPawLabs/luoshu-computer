import Database from 'better-sqlite3';
import {NativeUnitRegistry} from '../../src/engines/native-unit-registry.js';
import {spawnSystemdSupervisor} from '../../src/engines/native-systemd-supervisor.js';

const [path,root,mode]=process.argv.slice(2),db=new Database(path!);db.pragma('journal_mode=WAL');db.pragma('synchronous=FULL');
const lease=await new NativeUnitRegistry(db).acquire('worker');
if(mode==='reserved'||mode==='committed'){
 if(mode==='committed')lease.committed();process.send?.({type:'stage',unit:lease.unitName});
}else{
 const code="const {spawn}=require('node:child_process');const d=spawn(process.execPath,['-e',\"process.send(process.pid);process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{detached:true,stdio:['ignore','ignore','ignore','ipc']});d.once('message',pid=>process.stdout.write(JSON.stringify({target:process.pid,descendant:pid})+'\\n'));process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
 const native=spawnSystemdSupervisor({executable:process.execPath,args:['-e',code],cwd:root,env:{},lease});
 native.stdout.once('data',data=>process.send?.({type:'running',unit:lease.unitName,supervisor:native.pid,...JSON.parse(data.toString())}));native.stderr.resume();
}
setInterval(()=>{},1000);
