import type Database from 'better-sqlite3';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {NativeSystemdUnit,type NativeUnitRuntime} from './native-systemd-unit.js';

interface ProcessIdentity {boot:string;pid:number;start:string}
interface Row {worker_id:string;unit_name:string;owner_token:string;owner_json:string;phase:'reserved'|'committed'|'observed';runtime_json:string|null}
export interface NativeUnitLease {unitName:string;ownerToken:string;committed:()=>void;observed:(runtime:NativeUnitRuntime)=>void;released:()=>void}
async function processState(pid:number){
 try{const raw=await readFile(`/proc/${pid}/stat`,'utf8'),fields=raw.slice(raw.lastIndexOf(')')+2).split(' ');if(!/^\d+$/u.test(fields[19]??''))throw Error('Native owner identity unknown');return{start:fields[19]!,alive:!['Z','X'].includes(fields[0]!)};}
 catch(error){if(['ENOENT','ESRCH'].includes((error as NodeJS.ErrnoException).code??''))return null;throw error;}
}
/** Durable lifecycle ownership, never an Agent execution journal. Unknown
 * launch intent stays fenced; it is not evidence that a turn may be replayed. */
export class NativeUnitRegistry {
 constructor(private db:Database.Database){db.exec(`CREATE TABLE IF NOT EXISTS native_systemd_units(
  worker_id TEXT PRIMARY KEY,unit_name TEXT NOT NULL UNIQUE,owner_token TEXT NOT NULL,
  owner_json TEXT NOT NULL,phase TEXT NOT NULL,runtime_json TEXT);`);}
 private row(worker:string){return this.db.prepare('SELECT * FROM native_systemd_units WHERE worker_id=?').get(worker) as Row|undefined;}
 async quiesce(worker:string):Promise<void>{
  const previous=this.row(worker);
  if(previous){
   const boot=(await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim();
   const owner=JSON.parse(previous.owner_json) as ProcessIdentity;
   if(!Number.isSafeInteger(owner.pid)||owner.pid<2||!/^\d+$/u.test(owner.start)||typeof owner.boot!=='string')throw Error('Native owner identity unknown');
   const live=owner.boot===boot?await processState(owner.pid):null;
   if(live?.alive&&live.start===owner.start)throw Error('Native unit owner is still active');
   if(previous.phase!=='reserved'){
    const authority=new NativeSystemdUnit({unitName:previous.unit_name,ownerToken:previous.owner_token},undefined,previous.runtime_json?JSON.parse(previous.runtime_json):undefined);
    const deadline=Date.now()+6000;
    for(;;){const snapshot=await authority.inspect();if(snapshot.state==='stopped')break;if(snapshot.state==='missing')throw Error('Native unit launch remains unknown');if(Date.now()>=deadline)throw Error('Native unit exit remains unknown');await authority.stop();await new Promise(r=>setTimeout(r,50));}
   }
   this.db.transaction(()=>{if(JSON.stringify(this.row(worker))!==JSON.stringify(previous))throw Error('Native unit owner changed');this.db.prepare('DELETE FROM native_systemd_units WHERE worker_id=? AND owner_token=?').run(worker,previous.owner_token);})();
  }
 }
 async acquire(worker:string):Promise<NativeUnitLease>{
  const boot=(await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim(),self=await processState(process.pid);if(!self?.alive)throw Error('Native owner identity unknown');
  await this.quiesce(worker);
  const unitName='luoshu-codex-'+randomUUID().replaceAll('-',''),ownerToken=randomUUID(),ownerJson=JSON.stringify({boot,pid:process.pid,start:self.start});
  this.db.transaction(()=>{
   if(this.row(worker))throw Error('Native unit owner changed');
   this.db.prepare("INSERT INTO native_systemd_units VALUES(?,?,?,?,'reserved',NULL)").run(worker,unitName,ownerToken,ownerJson);
  })();
  const current=()=>{const row=this.row(worker);if(!row||row.owner_token!==ownerToken||row.unit_name!==unitName||row.owner_json!==ownerJson)throw Error('Native unit lease changed');return row;};
  return{unitName,ownerToken,
   committed:()=>{const row=current();if(row.phase!=='reserved')throw Error('Native launch already committed');this.db.prepare("UPDATE native_systemd_units SET phase='committed' WHERE worker_id=? AND owner_token=?").run(worker,ownerToken);},
   observed:runtime=>{const row=current();if(row.phase==='reserved')throw Error('Native launch has not committed');new NativeSystemdUnit({unitName,ownerToken},undefined,runtime);if(row.runtime_json&&row.runtime_json!==JSON.stringify(runtime))throw Error('Native runtime identity changed');this.db.prepare("UPDATE native_systemd_units SET phase='observed',runtime_json=? WHERE worker_id=? AND owner_token=?").run(JSON.stringify(runtime),worker,ownerToken);},
   released:()=>{current();this.db.prepare('DELETE FROM native_systemd_units WHERE worker_id=? AND owner_token=?').run(worker,ownerToken);},
  };
 }
}
