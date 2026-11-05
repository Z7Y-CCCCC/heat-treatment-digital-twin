'use strict';
// Code-native bitmap artwork for NSIS: no browser or image runtime dependency.
const fs=require('node:fs'),path=require('node:path');
function bitmap(width,height,header=false){
    const stride=(width*3+3)&~3,pixels=Buffer.alloc(stride*height);
    function dot(x,y,rgb){if(x<0||y<0||x>=width||y>=height)return;const p=(height-1-y)*stride+x*3;pixels[p]=rgb[2];pixels[p+1]=rgb[1];pixels[p+2]=rgb[0]}
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){
        const v=y/height,g=Math.max(0,1-Math.hypot((x-width*.45)/width,(y-height*.3)/height));
        dot(x,y,header?[248,249,253]:[Math.round(25+g*20+v*4),Math.round(30+g*17),Math.round(58+g*45)]);
    }
    function line(x1,y1,x2,y2,color){const steps=Math.max(Math.abs(x2-x1),Math.abs(y2-y1));for(let t=0;t<=steps;t++)dot(Math.round(x1+(x2-x1)*t/steps),Math.round(y1+(y2-y1)*t/steps),color)}
    const cx=header?width-35:width/2,cy=header?height/2:height*.26,s=header?19:34;
    const a=[cx,cy-s],b=[cx+s*.85,cy-s*.48],c=[cx+s*.85,cy+s*.48],d=[cx,cy+s],e=[cx-s*.85,cy+s*.48],f=[cx-s*.85,cy-s*.48];
    for(const [p,q] of [[a,b],[b,c],[c,d],[d,e],[e,f],[f,a],[b,[cx,cy]],[f,[cx,cy]],[[cx,cy],d]])line(...p,...q,header?[96,112,211]:[172,179,248]);
    if(!header){
        for(let k=0;k<5;k++){const y=height*.56+k*22;line(22,y,width-22,y,[56,64,101]);for(let n=0;n<5;n++)line(24+n*26,y-11,24+n*26,y,[77,83,128]);}
        line(cx,cy+s+18,cx,height*.52,[92,104,185]);
    }
    const data=Buffer.alloc(54+pixels.length);data.write('BM');data.writeUInt32LE(data.length,2);data.writeUInt32LE(54,10);data.writeUInt32LE(40,14);data.writeInt32LE(width,18);data.writeInt32LE(height,22);data.writeUInt16LE(1,26);data.writeUInt16LE(24,28);pixels.copy(data,54);return data;
}
if(require.main===module){const assets=path.resolve(__dirname,'../assets');const art=require('./installer-art.cjs');fs.writeFileSync(path.join(assets,'installer-art.bmp'),art.bitmap(600,1100));fs.writeFileSync(path.join(assets,'installer-sidebar.bmp'),art.bitmap(164,314));fs.writeFileSync(path.join(assets,'installer-header.bmp'),bitmap(150,57,true));}
module.exports={bitmap};
