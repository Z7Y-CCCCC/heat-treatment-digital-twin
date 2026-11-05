'use strict';
// Deterministic extension of the project's original code-native NSIS artwork.
// Ice-blue isometric campus: no browser, extra plugin or customer dependency.
const fs = require('node:fs'), path = require('node:path');
function bitmap(width, height) {
  const stride = (width * 3 + 3) & ~3, pixels = Buffer.alloc(stride * height);
  function dot(x, y, rgb, alpha = 1) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const p = (height - 1 - y) * stride + x * 3;
    for (let i = 0; i < 3; i++) pixels[p + i] = Math.round(pixels[p + i] * (1 - alpha) + rgb[2 - i] * alpha);
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const glow = Math.max(0, 1 - Math.hypot((x - width * .55) / width, (y - height * .55) / height));
    dot(x, y, y < height * .24 ? [237, 248, 252] : [237 - glow * 12, 248 - glow * 2, 252]);
  }
  function line(a, b, color, alpha = 1, thickness = 1) {
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]))));
    for (let t = 0; t <= steps; t++) for (let j = 0; j < thickness; j++)
      dot(a[0] + (b[0] - a[0]) * t / steps, a[1] + (b[1] - a[1]) * t / steps + j, color, alpha);
  }
  function polygon(points, color, alpha = 1) {
    const min = Math.max(0, Math.floor(Math.min(...points.map(p => p[1])))), max = Math.min(height - 1, Math.ceil(Math.max(...points.map(p => p[1]))));
    for (let y = min; y <= max; y++) {
      const xs = [];
      for (let i = 0; i < points.length; i++) {
        const a = points[i], b = points[(i + 1) % points.length];
        if ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y)) xs.push(a[0] + (y - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
      }
      xs.sort((a, b) => a - b);
      for (let i = 0; i + 1 < xs.length; i += 2) for (let x = Math.ceil(xs[i]); x <= xs[i + 1]; x++) dot(x, y, color, alpha);
    }
  }
  const s = width / 600, origin = [width * .5, height * .65];
  const iso = (x, y, z = 0) => [origin[0] + (x - y) * .86 * s, origin[1] + ((x + y) * .45 - z) * s];
  const edge = [109, 190, 218];
  function box(x, y, w, d, h, colors = [[166, 221, 240], [98, 184, 218], [222, 248, 252]], z = 0) {
    const a = iso(x, y, h + z), b = iso(x + w, y, h + z), c = iso(x + w, y + d, h + z), e = iso(x, y + d, h + z);
    const B = iso(x + w, y, z), C = iso(x + w, y + d, z), E = iso(x, y + d, z);
    polygon([e, c, C, E], colors[0]); polygon([b, c, C, B], colors[1]); polygon([a, b, c, e], colors[2]);
    for (const [p, q] of [[a,b],[b,c],[c,e],[e,a],[b,B],[c,C],[e,E],[E,C],[C,B]]) line(p,q,edge,.7,Math.max(1,Math.round(s)));
  }
  for (let n = -420; n <= 420; n += 55) { line(iso(-440,n),iso(440,n),[153,210,230],.32); line(iso(n,-440),iso(n,440),[153,210,230],.32); }
  for (let i = 24; i > 0; i--) polygon([iso(-170,-135,-i),iso(170,-135,-i),iso(170,135,-i),iso(-170,135,-i)],[120,181,210],.014);
  box(-165,-125,330,250,16,[[209,233,245],[174,216,237],[251,254,255]],-12);
  for (let n = -130; n <= 130; n += 32) {line(iso(-150,n,6),iso(150,n,6),[180,224,239],.8);line(iso(n,-110,6),iso(n,110,6),[180,224,239],.8);}
  box(-122,-72,62,60,68); box(-26,-94,63,64,125); box(68,-67,59,65,95);
  box(-125,35,81,56,44,[[181,228,239],[100,196,213],[231,251,252]]);
  box(16,40,109,55,38,[[169,224,242],[95,180,220],[232,249,255]]);
  for (const [x,y,w,d,h] of [[-122,-72,62,60,68],[-26,-94,63,64,125],[68,-67,59,65,95]]) {
    for (let a = 8; a < w; a += 10) line(iso(x+a,y+d,h-7),iso(x+a,y+d,8),[238,254,255],.85);
    for (let a = 8; a < d; a += 10) line(iso(x+w,y+a,h-7),iso(x+w,y+a,8),[183,240,250],.85);
    for (let z = 20; z < h; z += 17) {line(iso(x,y+d,z),iso(x+w,y+d,z),[223,251,255],.9);line(iso(x+w,y,z),iso(x+w,y+d,z),[154,219,239],.9);}
    box(x+12,y+12,w-24,d-24,6,[[194,229,244],[147,201,227],[245,254,255]],h);
  }
  for (let n = 0; n < 4; n++) box(26+n*22,48,12,31,6,[[166,224,237],[91,184,211],[219,249,255]],38);
  for (const [a,b] of [[[-88,15,10],[80,15,10]],[[80,15,10],[80,35,10]],[[-88,15,10],[-88,32,10]]]) line(iso(...a),iso(...b),[27,177,184],.95,Math.max(2,Math.round(s*3)));
  for (const [x,y] of [[-88,15],[80,15],[-88,32],[80,35]]) box(x-4,y-4,8,8,6,[[93,216,215],[26,181,188],[212,255,255]],8);
  const cx = width*.76, cy = height*.32, r = width*.11;
  const pts=[[cx,cy-r],[cx+r*.86,cy-r*.5],[cx+r*.86,cy+r*.5],[cx,cy+r],[cx-r*.86,cy+r*.5],[cx-r*.86,cy-r*.5],[cx,cy]];
  polygon([pts[0],pts[1],pts[6],pts[5]],[205,240,249],.8);polygon([pts[1],pts[2],pts[3],pts[6]],[116,197,228],.25);
  for(const [a,b] of [[0,1],[1,2],[2,3],[3,4],[4,5],[5,0],[1,6],[5,6],[6,3]])line(pts[a],pts[b],[93,184,214],.5);
  line([width*.23,height*.28],[width*.23,height*.40],[85,188,205],.5);
  for(let i=0;i<14;i++){const x=width*(.12+(i*37%75)/100),y=height*(.36+(i*13%48)/100);dot(x,y,[70,177,201],.55);dot(x+1,y,[70,177,201],.55);}
  const data = Buffer.alloc(54 + pixels.length); data.write('BM'); data.writeUInt32LE(data.length,2);data.writeUInt32LE(54,10);data.writeUInt32LE(40,14);data.writeInt32LE(width,18);data.writeInt32LE(height,22);data.writeUInt16LE(1,26);data.writeUInt16LE(24,28); pixels.copy(data,54); return data;
}
if (require.main === module) {
  fs.writeFileSync(path.resolve(__dirname,'../assets/installer-art.bmp'),bitmap(600,1100));
  fs.writeFileSync(path.resolve(__dirname,'../assets/installer-sidebar.bmp'),bitmap(164,314));
}
module.exports = { bitmap };
