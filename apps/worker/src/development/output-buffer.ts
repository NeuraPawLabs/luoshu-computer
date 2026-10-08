/** A bounded replay log, preserving complete Unicode characters and event IDs. */
export class PtyOutputBuffer {
 private chunks:{sequence:number;data:string}[]=[];
 private bytes=0;
 nextSequence=1;
 constructor(private readonly maxBytes=512*1024,private readonly maxChunks=2048){}
 append(data:string):{sequence:number;data:string}[]{
  const result:{sequence:number;data:string}[]=[];
  // At most 4 Ki UTF-16 units / 16 KiB per message. Never split a surrogate pair.
  for(let start=0;start<data.length;){
   let end=Math.min(start+4096,data.length);
   if(end<data.length&&/[\uD800-\uDBFF]/.test(data[end-1]))end--;
   const text=data.slice(start,end),chunk={sequence:this.nextSequence++,data:text};start=end;
   this.chunks.push(chunk);this.bytes+=Buffer.byteLength(text);result.push(chunk);
   while(this.bytes>this.maxBytes||this.chunks.length>this.maxChunks)this.bytes-=Buffer.byteLength(this.chunks.shift()!.data);
  }
  return result;
 }
 read(after:number){const first=this.chunks[0]?.sequence??this.nextSequence;return{chunks:this.chunks.filter(c=>c.sequence>after),next_sequence:this.nextSequence,truncated:after<first-1};}
}
