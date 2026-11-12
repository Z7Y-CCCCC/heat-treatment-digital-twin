'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
function verifyGeneratedNotice(root,unpacked){
  const source=fs.readFileSync(path.join(root,'desktop/THIRD_PARTY_NOTICES.txt'),'utf8').replace(/\r\n/g,'\n');
  const installed=fs.readFileSync(path.join(unpacked,'resources/THIRD_PARTY_NOTICES.txt'),'utf8').replace(/\r\n/g,'\n');
  if(source!==installed)throw Error('Generated third-party notice differs from the verified application; a full build is required');
  return {success:true,sha256:crypto.createHash('sha256').update(source).digest('hex'),lineEndingsNormalized:true};
}
if(require.main===module){try{console.log(JSON.stringify(verifyGeneratedNotice(path.resolve(process.argv[2]),path.resolve(process.argv[3]))));}catch(error){console.error(error.message);process.exitCode=1;}}
module.exports={verifyGeneratedNotice};
