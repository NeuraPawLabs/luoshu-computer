import {runGitSshHelper} from './git-helper.js';
const [flag,socket,...args]=process.argv.slice(2);
try{if(flag!=='--socket'||!socket)throw Error('Git SSH helper requires --socket');process.exitCode=await runGitSshHelper(args,socket);}
catch(error){console.error(error instanceof Error?error.message:'Git SSH failed');process.exitCode=1;}
