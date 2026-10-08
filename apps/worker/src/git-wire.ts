import type {Readable,Writable} from 'node:stream';
/** Bounded newline frames for local SSH I/O. Credentials never use this channel. */
export function receiveGitFrames(stream:Readable,onFrame:(value:any)=>void):void {
 let pending='';stream.setEncoding('utf8');stream.on('data',chunk=>{
  pending+=chunk;if(pending.length>2_000_000){stream.destroy(Error('Git helper frame too large'));return;}
  let at;while((at=pending.indexOf('\n'))>=0){const line=pending.slice(0,at);pending=pending.slice(at+1);try{onFrame(JSON.parse(line));}catch{stream.destroy(Error('Invalid Git helper frame'));return;}}
 });
}
export function sendGitFrame(stream:Writable,value:unknown):boolean{return !stream.destroyed&&stream.write(JSON.stringify(value)+'\n');}
