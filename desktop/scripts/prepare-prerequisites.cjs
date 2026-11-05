'use strict';
const fs=require('node:fs'),path=require('node:path');
const {pipeline}=require('node:stream/promises'),{Readable}=require('node:stream'),{execFileSync}=require('node:child_process');
const {fileDigest}=require('./file-digest.cjs');
const PACKAGES=[{name:'vc_redist.x64.exe',url:'https://aka.ms/vs/17/release/vc_redist.x64.exe'},
    {name:'MicrosoftEdgeWebView2RuntimeInstallerX64.exe',url:'https://go.microsoft.com/fwlink/?LinkId=2124701'}];
function verifyMicrosoft(file){
    const script=`$ProgressPreference='SilentlyContinue';$env:PSModulePath=(Join-Path $PSHOME 'Modules');$s=Get-AuthenticodeSignature -LiteralPath '${file.replace(/'/g,"''")}';if($s.Status -ne 'Valid' -or $s.SignerCertificate.Subject -notmatch '(?:^|,\\s*)O=Microsoft Corporation(?:,|$)'){throw 'Microsoft signature invalid'};[Console]::WriteLine($s.SignerCertificate.Subject)`;
    return execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,encoding:'utf8',timeout:30000}).trim();
}
async function preparePrerequisites(destination=path.join(process.env.DESKTOP_RESOURCES_DIR || path.resolve(__dirname,'../resources'), 'prerequisites')){
    if(process.platform!=='win32')throw new Error('Microsoft runtime signatures must be verified on Windows');
    fs.mkdirSync(destination,{recursive:true});const cache=path.resolve(__dirname,'../.cache/prerequisites');fs.mkdirSync(cache,{recursive:true});const files=[];
    for(const pkg of PACKAGES){
        const file=path.join(cache,pkg.name);
        if(!fs.existsSync(file)&&fs.existsSync(path.join(destination,pkg.name)))fs.copyFileSync(path.join(destination,pkg.name),file);
        if(!fs.existsSync(file)){
            console.log(`Download Microsoft runtime: ${pkg.name}`);
            const response=await fetch(pkg.url,{signal:AbortSignal.timeout(300000)});
            if(!response.ok||!response.body)throw new Error(`Runtime download HTTP ${response.status}`);
            const temporary=`${file}.preparing-${process.pid}.exe`;
            await pipeline(Readable.fromWeb(response.body),fs.createWriteStream(temporary,{flags:'wx'}));
            try{verifyMicrosoft(temporary);fs.renameSync(temporary,file)}catch(error){fs.unlinkSync(temporary);throw error}
        }
        const publisher=verifyMicrosoft(file),proof=fileDigest(file);
        if(proof.size<1000000||proof.size>600*1024*1024)throw new Error('Runtime payload size is invalid');
        fs.copyFileSync(file,path.join(destination,pkg.name));
        files.push({...pkg,...proof,publisher});
    }
    fs.writeFileSync(path.join(destination,'manifest.json'),JSON.stringify({files},null,2));
    fs.copyFileSync(path.resolve(__dirname,'../RuntimePrerequisites.ps1'),path.join(destination,'RuntimePrerequisites.ps1'));
    return files;
}
if(require.main===module)preparePrerequisites().then(files=>console.log(JSON.stringify(files,null,2))).catch(error=>{console.error(error);process.exitCode=1});
module.exports={preparePrerequisites,PACKAGES};
