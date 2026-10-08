import {expect,test} from 'vitest';
import {PtyOutputBuffer} from '../src/development/output-buffer.js';

test('retains bounded complete UTF-8 chunks and reports every truncated cursor',()=>{
 const output=new PtyOutputBuffer(128,4);
 for(let i=0;i<20;i++)output.append(`第${i}条🌟\r\n`);
 const snapshot=output.read(0);
 expect(snapshot.truncated).toBe(true);expect(snapshot.chunks.length).toBeLessThanOrEqual(4);
 expect(Buffer.byteLength(snapshot.chunks.map(c=>c.data).join(''))).toBeLessThanOrEqual(128);
 expect(snapshot.chunks.map(c=>c.data).join('')).not.toContain('\ufffd');
 expect(output.read(snapshot.chunks[0].sequence-1).truncated).toBe(false);
});
test('a large PTY write is split on text boundaries and fits the read protocol',()=>{
 const output=new PtyOutputBuffer();const chunks=output.append('🌟中文'.repeat(200000));
 expect(chunks.every(c=>Buffer.byteLength(c.data)<=16384)).toBe(true);
 const snapshot=output.read(0);expect(snapshot.truncated).toBe(true);expect(snapshot.chunks.length).toBeLessThanOrEqual(2048);
 expect(Buffer.byteLength(snapshot.chunks.map(c=>c.data).join(''))).toBeLessThanOrEqual(512*1024);
 expect(snapshot.chunks.map(c=>c.data).join('')).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
});
