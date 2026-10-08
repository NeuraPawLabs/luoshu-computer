import {deflateRaw} from 'node:zlib';
import {promisify} from 'node:util';

export interface ArchiveEntry {path:string;bytes:Buffer;mode:number}
const compress=promisify(deflateRaw);

// Bounded ZIP32 with UTF-8 paths, Unix permissions and no links. Compression
// yields to the event loop so lease renewal and cancellation can still run.
export async function createOutputZip(entries:ArchiveEntry[],maxBytes:number):Promise<Buffer>{
 const chunks:Buffer[]=[],central:Buffer[]=[];
 let offset=0,centralSize=0;
 for(const entry of entries){
  const name=Buffer.from(entry.path,'utf8'),directory=entry.path.endsWith('/');
  const data=directory?Buffer.alloc(0):await compress(entry.bytes),method=directory?0:8,crc=crc32(entry.bytes);
  const local=Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50,0);
  local.writeUInt16LE(20,4);local.writeUInt16LE(0x0800,6);local.writeUInt16LE(method,8);
  local.writeUInt16LE(0x21,12); // 1980-01-01, valid deterministic DOS date
  local.writeUInt32LE(crc,14);local.writeUInt32LE(data.length,18);local.writeUInt32LE(entry.bytes.length,22);
  local.writeUInt16LE(name.length,26);
  const record=Buffer.alloc(46);
  record.writeUInt32LE(0x02014b50,0);record.writeUInt16LE(0x0314,4); // Unix, ZIP 2.0
  record.writeUInt16LE(20,6);record.writeUInt16LE(0x0800,8);record.writeUInt16LE(method,10);
  record.writeUInt16LE(0x21,14);
  record.writeUInt32LE(crc,16);record.writeUInt32LE(data.length,20);record.writeUInt32LE(entry.bytes.length,24);
  record.writeUInt16LE(name.length,28);
  record.writeUInt32LE(((entry.mode<<16)|(directory?0x10:0))>>>0,38);record.writeUInt32LE(offset,42);
  offset+=local.length+name.length+data.length;centralSize+=record.length+name.length;
  if(offset+centralSize+22>maxBytes)throw new Error('Output ZIP exceeds 10 MiB');
  chunks.push(local,name,data);central.push(record,name);
 }
 const end=Buffer.alloc(22);
 end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);
 end.writeUInt32LE(centralSize,12);end.writeUInt32LE(offset,16);
 return Buffer.concat([...chunks,...central,end]);
}
function crc32(data:Buffer):number{
 let crc=0xffffffff;
 for(const byte of data){
  crc^=byte;
  for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);
 }
 return(crc^0xffffffff)>>>0;
}
