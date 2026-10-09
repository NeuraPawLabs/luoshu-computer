import {expect,test} from 'vitest';
import {computerReleaseManifestSchema,MAX_COMPUTER_RELEASE_BYTES} from '../../src/protocol/computer-release.js';
import {PROTOCOL_VERSION} from '../../src/protocol/index.js';

const release={path:'/computer/releases/0.1.5/linux-x64.tar.gz',sha256:'a'.repeat(64),size:123};
const manifest={version:'0.1.5',protocol_version:PROTOCOL_VERSION,releases:{'linux-x64':release}};
test('Computer release protocol validates versioned manifests without accepting execution instructions',()=>{
 expect(computerReleaseManifestSchema.parse(manifest)).toEqual(manifest);
 expect(computerReleaseManifestSchema.safeParse({...manifest,protocol_version:PROTOCOL_VERSION-1}).success).toBe(false);
 expect(computerReleaseManifestSchema.safeParse({...manifest,command:'sh untrusted'}).success).toBe(false);
});
test.each(['https://other.example/release.tar.gz','//other.example/a','/computer/../secret','/computer/%2e%2e/a','/computer/a?token=x','/computer/a#x','/computer/a\\b','/computer/a\n'])('Computer archives reject unsafe path %s',path=>{
 expect(computerReleaseManifestSchema.safeParse({...manifest,releases:{'linux-x64':{...release,path}}}).success).toBe(false);
});
test.each([0,-1,1.5,MAX_COMPUTER_RELEASE_BYTES+1])('Computer archive size is bounded: %s',size=>{
 expect(computerReleaseManifestSchema.safeParse({...manifest,releases:{'linux-x64':{...release,size}}}).success).toBe(false);
});
